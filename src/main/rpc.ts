import { Cause, Effect, Layer, Stream } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { ArcRpcs, type RpcError } from "../shared/rpc.js"
import { ElectronRpcServerProtocol } from "./rpc-transport.js"
import { WorkspaceService } from "./services/WorkspaceService.js"
import { WorkspaceFilesService } from "./services/WorkspaceFilesService.js"
import { GitService } from "./services/GitService.js"
import { toWirePullRequest, toWireWorktree } from "./services/git/wire.js"
import { ProviderRegistry } from "./services/ProviderRegistry.js"
import { PresetRegistry } from "./services/PresetRegistry.js"
import { ChatService } from "./services/ChatService.js"
import { ActivityEventService } from "./services/ActivityEventService.js"
import { ChatMessageService } from "./services/ChatMessageService.js"
import { LocalModelService } from "./services/LocalModelService.js"
import { TargetSessionManager } from "./services/TargetSessionManager.js"
import { LiveTargetStateService } from "./services/LiveTargetStateService.js"
import { CodexDriverRegistry } from "./services/CodexDriverRegistry.js"
import { SessionRuntimeRouter } from "./services/SessionRuntimeRouter.js"
import { projectApprovals, parseDecisionPayload } from "./services/codex-approval-view.js"
import { ArtifactIngestService } from "./services/ArtifactIngestService.js"
import { WorkService } from "./work/service.js"
import { ReadService } from "./read/service.js"
import { ArcRequestError } from "./errors.js"

/**
 * Wrap a handler effect with the RPC seam's observability + error policy.
 *
 * Each call runs inside an `rpc.server.<tag>` span (attributes carry the tag),
 * so once an OTLP layer is wired every request is a trace; `Effect.log*` lines
 * emitted within nest under that span. A handler failure is mapped to a typed
 * {@link RpcError}: an `ArcRequestError` is an expected, user-facing condition
 * logged at info and surfaced verbatim; anything else is logged at error with
 * its full cause and collapsed to a generic message, so internals never leak
 * across the seam.
 */
const rpcEffect = <A, E, R>(tag: string, effect: Effect.Effect<A, E, R>): Effect.Effect<A, RpcError, R> =>
  Effect.logDebug(`rpc request ${tag}`).pipe(
    Effect.andThen(effect),
    Effect.tap(() => Effect.logDebug(`rpc ok ${tag}`)),
    Effect.catchCause((cause) => {
      const failure = Cause.squash(cause)
      if (failure instanceof ArcRequestError) {
        return Effect.logInfo(`rpc rejected ${tag}: ${failure.message}`).pipe(
          Effect.andThen(Effect.fail<RpcError>({ _tag: "ArcRequestError", message: failure.message })),
        )
      }
      return Effect.logError(`rpc failed ${tag}`, cause).pipe(
        Effect.andThen(Effect.fail<RpcError>({ _tag: "ArcUnexpectedError", message: "Unexpected RPC failure" })),
      )
    }),
    Effect.withSpan(`rpc.server.${tag}`, { attributes: { "rpc.tag": tag } }),
  )

/**
 * Handler combinator: resolve a service, run a method against it (and the
 * request), and wrap the result in the {@link rpcEffect} seam. Captures the
 * `flatMap(Service, …)` resolve that nearly every handler repeats, so each entry
 * reads as `Tag: svc("Tag", Service, (s, req) => s.method(req))`. The `run`
 * callback returns any effect, so map/as post-processing (toWire, {removed:true})
 * stays inline. The object key still names the rpc — the contract drives the
 * types, so a mis-shaped handler is still a compile error.
 */
const svc =
  <S, SR, Req, A, E, R>(
    tag: string,
    service: Effect.Effect<S, never, SR>,
    run: (s: S, req: Req) => Effect.Effect<A, E, R>,
  ) =>
  (req: Req): Effect.Effect<A, RpcError, SR | R> =>
    rpcEffect(tag, Effect.flatMap(service, (s) => run(s, req)))

/**
 * The handler table — one entry per rpc, each a decode -> run `Service` -> encode
 * shell over the same domain services the rest of the app uses. The `ArcRpcs`
 * contract drives the types: a missing or mis-shaped handler is a compile error.
 */
export const ArcRpcHandlersLive = ArcRpcs.toLayer(
  Effect.succeed({
    ListWorkspaces: svc("ListWorkspaces", WorkspaceService, (_) => _.list),
    OpenWorkspace: svc("OpenWorkspace", WorkspaceService, (_) =>
      Effect.map(_.open, (workspace) => ({ workspace })),
    ),
    ListProviders: svc("ListProviders", ProviderRegistry, (_) => _.list),
    ListWorkspaceFiles: svc("ListWorkspaceFiles", WorkspaceFilesService, (_, req) => _.list(req.workspaceId)),
    GetWorkspaceGitStatus: svc("GetWorkspaceGitStatus", GitService, (_, req) => _.status(req.workspaceId)),
    GetWorkspaceGitFileDiff: svc("GetWorkspaceGitFileDiff", GitService, (_, req) =>
      _.diff(req.workspaceId, req.path),
    ),
    GetWorkspaceGitCommits: svc("GetWorkspaceGitCommits", GitService, (_, req) =>
      _.commits(req.workspaceId, req.limit),
    ),
    GetWorkspaceGitContext: svc("GetWorkspaceGitContext", GitService, (_, req) => _.gitContext(req.workspaceId)),
    SyncWorkspacePullRequests: svc("SyncWorkspacePullRequests", GitService, (_, req) =>
      Effect.map(_.syncPullRequests(req.workspaceId), (rows) => rows.map(toWirePullRequest)),
    ),
    CreateWorktree: svc("CreateWorktree", GitService, (_, req) =>
      Effect.map(
        _.createWorktree(req.workspaceId, {
          branch: req.branch,
          baseRef: req.baseRef,
          createBranch: req.createBranch,
          carryChanges: req.carryChanges,
        }),
        toWireWorktree,
      ),
    ),
    OpenWorktree: svc("OpenWorktree", GitService, (_, req) => _.openWorktree(req.worktreePath)),
    RemoveWorktree: svc("RemoveWorktree", GitService, (_, req) =>
      Effect.as(_.removeWorktree(req.workspaceId, req.worktreePath, { force: req.force }), { removed: true }),
    ),
    PruneWorktrees: svc("PruneWorktrees", GitService, (_, req) =>
      Effect.map(_.pruneWorktrees(req.workspaceId), (removed) => ({ removed })),
    ),
    CreatePullRequest: svc("CreatePullRequest", GitService, (_, req) =>
      Effect.map(
        _.createPullRequest(req.workspaceId, {
          title: req.title,
          body: req.body,
          base: req.base,
          draft: req.draft,
        }),
        (pr) => (pr ? toWirePullRequest(pr) : null),
      ),
    ),
    ListPresets: svc("ListPresets", PresetRegistry, (_) => _.list),
    ListInstances: svc("ListInstances", TargetSessionManager, (_) => _.list),
    ListSessions: svc("ListSessions", SessionRuntimeRouter, (_) => _.sessions),
    // Streaming handlers: return each service's reactive `changes` stream
    // directly. The streams replay (or derive) their current value on subscribe,
    // so a fresh client gets the snapshot then live updates — no separate boot
    // push. Their error channel is `never`, so the `rpcEffect` request/error
    // wrapper (Effect-shaped) doesn't apply here.
    WatchSessions: () => Stream.unwrap(Effect.map(SessionRuntimeRouter, (_) => _.changes)),
    WatchChats: () => Stream.unwrap(Effect.map(ChatService, (_) => _.changes)),
    WatchWorkspaces: () => Stream.unwrap(Effect.map(WorkspaceService, (_) => _.changes)),
    WatchLiveTargetStates: () =>
      Stream.unwrap(Effect.map(LiveTargetStateService, (_) => _.changes)),
    WatchAppServerApprovals: () =>
      Stream.unwrap(Effect.map(CodexDriverRegistry, (_) => Stream.map(_.changes, projectApprovals))),
    // Invalidation-signal streams: forward each service's change PubSub as a
    // stream of tiny descriptors (the renderer re-pulls the affected list). Unlike
    // the SubscriptionRef lists above these PubSubs don't replay, so a fresh
    // subscriber gets future ticks only — the renderer's query still does the
    // authoritative first pull, so no boot tick is needed.
    WatchChatMessageChanges: () => Stream.unwrap(Effect.map(ChatMessageService, (_) => _.changes)),
    WatchChatActivityChanges: () => Stream.unwrap(Effect.map(ActivityEventService, (_) => _.changes)),
    WatchWorkChanges: () => Stream.unwrap(Effect.map(WorkService, (_) => _.changes)),
    WatchGitChanges: () => Stream.unwrap(Effect.map(GitService, (_) => _.changes)),
    ListChats: svc("ListChats", ChatService, (_) => _.list),
    TestLocalModel: svc("TestLocalModel", LocalModelService, (_) => _.status),
    ListPendingRequests: svc("ListPendingRequests", ChatMessageService, (_) => _.listPending),
    ListLiveTargetStates: svc("ListLiveTargetStates", LiveTargetStateService, (_) => _.list),
    ListAppServerApprovals: svc("ListAppServerApprovals", CodexDriverRegistry, (_) =>
      Effect.map(_.pending, projectApprovals),
    ),
    AnswerAppServerApproval: svc("AnswerAppServerApproval", CodexDriverRegistry, (_, req) =>
      _.answerApproval(req.targetSessionId, req.requestId, parseDecisionPayload(req.decisionPayload)),
    ),
    SearchArc: svc("SearchArc", ReadService, (_, req) => _.search(req.params)),
    GetArc: svc("GetArc", ReadService, (_, req) => _.get(req.params)),
    CreateChat: svc("CreateChat", ChatService, (_, req) => _.create(req.workspaceId, req.title)),
    UpdateChatTitle: svc("UpdateChatTitle", ChatService, (_, req) => _.updateTitle(req.chatId, req.title)),
    ListChatActivity: svc("ListChatActivity", ActivityEventService, (_, req) => _.listForChat(req.chatId)),
    ListChatMessages: svc("ListChatMessages", ChatMessageService, (_, req) => _.listForChat(req.chatId)),
    ReprojectChatMessages: svc("ReprojectChatMessages", ChatMessageService, (_, req) => _.reprojectChat(req.chatId)),
    ReingestWorkspaceArtifacts: svc("ReingestWorkspaceArtifacts", ArtifactIngestService, (_, req) =>
      _.ingestWorkspace(req.workspace, req.provider),
    ),
    ReingestAndReprojectChatMessages: svc("ReingestAndReprojectChatMessages", ArtifactIngestService, (_, req) =>
      _.reingestAndReprojectChat(req.chatId, req.provider),
    ),
    LaunchTarget: svc("LaunchTarget", SessionRuntimeRouter, (_, req) => _.launch(req)),
    ResumeTarget: svc("ResumeTarget", TargetSessionManager, (_, req) => _.resume(req)),
    StopTarget: svc("StopTarget", SessionRuntimeRouter, (_, req) => _.stop(req)),
    SubmitPrompt: svc("SubmitPrompt", TargetSessionManager, (_, req) => _.submit(req)),
    SendChatPrompt: svc("SendChatPrompt", ChatMessageService, (_, req) => _.sendPrompt(req)),
    ListWork: svc("ListWork", WorkService, (_) => _.listOpen),
    ListAllWork: svc("ListAllWork", WorkService, (_) => _.listAll),
    ListWorkForChat: svc("ListWorkForChat", WorkService, (_, req) => _.listForChat(req.chatId)),
    ListWorkComments: svc("ListWorkComments", WorkService, (_, req) =>
      _.listComments(req.id, { allRevisions: req.allRevisions }),
    ),
    CreateWork: svc("CreateWork", WorkService, (_, req) =>
      _.create(req.input, { source: "rpc", chatId: req.chatId }),
    ),
    UpdateWorkStatus: svc("UpdateWorkStatus", WorkService, (_, req) =>
      _.updateStatus(req.id, req.status, { source: "rpc" }),
    ),
    UpdateWorkPriority: svc("UpdateWorkPriority", WorkService, (_, req) =>
      _.updatePriority(req.id, req.priority, { source: "rpc" }),
    ),
    ReviseWork: svc("ReviseWork", WorkService, (_, req) => _.revise(req.id, req.edits, { source: "rpc" })),
  }),
)

/**
 * The running RPC server: the `ArcRpcs` contract, its handler table, and the
 * Electron IPC transport. Building this layer starts the server's receive loop;
 * it is merged into the main runtime (see `runtime.ts`) so it lives for the
 * process and shares the one set of domain-service instances. Its only open
 * requirements are those services, satisfied by `AppLive`.
 */
export const ArcRpcServerLive = RpcServer.layer(ArcRpcs).pipe(
  Layer.provide(ArcRpcHandlersLive),
  Layer.provide(ElectronRpcServerProtocol),
)
