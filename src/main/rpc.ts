import { Cause, Effect, Layer, Stream } from "effect"
import { RpcServer } from "effect/unstable/rpc"
import { ArcRpcs, type RpcError } from "../shared/rpc.js"
import { ElectronRpcServerProtocol } from "./rpc-transport.js"
import { WorkspaceService } from "./services/WorkspaceService.js"
import { WorkspaceFilesService } from "./services/WorkspaceFilesService.js"
import { GitService, toWirePullRequest } from "./services/GitService.js"
import { ProviderRegistry } from "./services/ProviderRegistry.js"
import { PresetRegistry } from "./services/PresetRegistry.js"
import { ChatService } from "./services/ChatService.js"
import { ActivityEventService } from "./services/ActivityEventService.js"
import { ChatMessageService } from "./services/ChatMessageService.js"
import { LocalModelService } from "./services/LocalModelService.js"
import { TargetSessionManager } from "./services/TargetSessionManager.js"
import { LiveTargetStateService } from "./services/LiveTargetStateService.js"
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
 * The handler table — one entry per rpc, each a decode -> run `Service` -> encode
 * shell over the same domain services the rest of the app uses. The `ArcRpcs`
 * contract drives the types: a missing or mis-shaped handler is a compile error.
 */
export const ArcRpcHandlersLive = ArcRpcs.toLayer(
  Effect.succeed({
    ListWorkspaces: () => rpcEffect("ListWorkspaces", Effect.flatMap(WorkspaceService, (_) => _.list)),
    OpenWorkspace: () =>
      rpcEffect(
        "OpenWorkspace",
        Effect.gen(function* () {
          return { workspace: yield* (yield* WorkspaceService).open }
        }),
      ),
    ListProviders: () => rpcEffect("ListProviders", Effect.flatMap(ProviderRegistry, (_) => _.list)),
    ListWorkspaceFiles: (req) =>
      rpcEffect(
        "ListWorkspaceFiles",
        Effect.flatMap(WorkspaceFilesService, (_) => _.list(req.workspaceId)),
      ),
    GetWorkspaceGitStatus: (req) =>
      rpcEffect("GetWorkspaceGitStatus", Effect.flatMap(GitService, (_) => _.status(req.workspaceId))),
    GetWorkspaceGitFileDiff: (req) =>
      rpcEffect(
        "GetWorkspaceGitFileDiff",
        Effect.flatMap(GitService, (_) => _.diff(req.workspaceId, req.path)),
      ),
    GetWorkspaceGitContext: (req) =>
      rpcEffect("GetWorkspaceGitContext", Effect.flatMap(GitService, (_) => _.gitContext(req.workspaceId))),
    SyncWorkspacePullRequests: (req) =>
      rpcEffect(
        "SyncWorkspacePullRequests",
        Effect.map(
          Effect.flatMap(GitService, (_) => _.syncPullRequests(req.workspaceId)),
          (rows) => rows.map(toWirePullRequest),
        ),
      ),
    ListPresets: () => rpcEffect("ListPresets", Effect.flatMap(PresetRegistry, (_) => _.list)),
    ListInstances: () => rpcEffect("ListInstances", Effect.flatMap(TargetSessionManager, (_) => _.list)),
    ListSessions: () => rpcEffect("ListSessions", Effect.flatMap(TargetSessionManager, (_) => _.list)),
    // Streaming handlers: return each service's reactive `changes` stream
    // directly. The streams replay (or derive) their current value on subscribe,
    // so a fresh client gets the snapshot then live updates — no separate boot
    // push. Their error channel is `never`, so the `rpcEffect` request/error
    // wrapper (Effect-shaped) doesn't apply here.
    WatchSessions: () => Stream.unwrap(Effect.map(TargetSessionManager, (_) => _.changes)),
    WatchChats: () => Stream.unwrap(Effect.map(ChatService, (_) => _.changes)),
    WatchWorkspaces: () => Stream.unwrap(Effect.map(WorkspaceService, (_) => _.changes)),
    WatchLiveTargetStates: () =>
      Stream.unwrap(Effect.map(LiveTargetStateService, (_) => _.changes)),
    // Invalidation-signal streams: forward each service's change PubSub as a
    // stream of tiny descriptors (the renderer re-pulls the affected list). Unlike
    // the SubscriptionRef lists above these PubSubs don't replay, so a fresh
    // subscriber gets future ticks only — the renderer's query still does the
    // authoritative first pull, so no boot tick is needed.
    WatchChatMessageChanges: () => Stream.unwrap(Effect.map(ChatMessageService, (_) => _.changes)),
    WatchChatActivityChanges: () => Stream.unwrap(Effect.map(ActivityEventService, (_) => _.changes)),
    WatchWorkChanges: () => Stream.unwrap(Effect.map(WorkService, (_) => _.changes)),
    ListChats: () => rpcEffect("ListChats", Effect.flatMap(ChatService, (_) => _.list)),
    TestLocalModel: () => rpcEffect("TestLocalModel", Effect.flatMap(LocalModelService, (_) => _.status)),
    ListPendingRequests: () =>
      rpcEffect("ListPendingRequests", Effect.flatMap(ChatMessageService, (_) => _.listPending)),
    ListLiveTargetStates: () =>
      rpcEffect("ListLiveTargetStates", Effect.flatMap(LiveTargetStateService, (_) => _.list)),
    SearchArc: (req) =>
      rpcEffect("SearchArc", Effect.flatMap(ReadService, (_) => _.search(req.params))),
    GetArc: (req) =>
      rpcEffect("GetArc", Effect.flatMap(ReadService, (_) => _.get(req.params))),
    CreateChat: (req) =>
      rpcEffect("CreateChat", Effect.flatMap(ChatService, (_) => _.create(req.workspaceId, req.title))),
    UpdateChatTitle: (req) =>
      rpcEffect(
        "UpdateChatTitle",
        Effect.flatMap(ChatService, (_) => _.updateTitle(req.chatId, req.title)),
      ),
    ListChatActivity: (req) =>
      rpcEffect(
        "ListChatActivity",
        Effect.flatMap(ActivityEventService, (_) => _.listForChat(req.chatId)),
      ),
    ListChatMessages: (req) =>
      rpcEffect(
        "ListChatMessages",
        Effect.flatMap(ChatMessageService, (_) => _.listForChat(req.chatId)),
      ),
    ReprojectChatMessages: (req) =>
      rpcEffect(
        "ReprojectChatMessages",
        Effect.flatMap(ChatMessageService, (_) => _.reprojectChat(req.chatId)),
      ),
    ReingestWorkspaceArtifacts: (req) =>
      rpcEffect(
        "ReingestWorkspaceArtifacts",
        Effect.flatMap(ArtifactIngestService, (_) => _.ingestWorkspace(req.workspace, req.provider)),
      ),
    ReingestAndReprojectChatMessages: (req) =>
      rpcEffect(
        "ReingestAndReprojectChatMessages",
        Effect.flatMap(ArtifactIngestService, (_) =>
          _.reingestAndReprojectChat(req.chatId, req.provider)
        ),
      ),
    LaunchTarget: (req) =>
      rpcEffect("LaunchTarget", Effect.flatMap(TargetSessionManager, (_) => _.launch(req))),
    ResumeTarget: (req) =>
      rpcEffect("ResumeTarget", Effect.flatMap(TargetSessionManager, (_) => _.resume(req))),
    StopTarget: (req) =>
      rpcEffect("StopTarget", Effect.flatMap(TargetSessionManager, (_) => _.stop(req))),
    SubmitPrompt: (req) =>
      rpcEffect("SubmitPrompt", Effect.flatMap(TargetSessionManager, (_) => _.submit(req))),
    SendChatPrompt: (req) =>
      rpcEffect("SendChatPrompt", Effect.flatMap(ChatMessageService, (_) => _.sendPrompt(req))),
    ListWork: () => rpcEffect("ListWork", Effect.flatMap(WorkService, (_) => _.listOpen)),
    ListAllWork: () => rpcEffect("ListAllWork", Effect.flatMap(WorkService, (_) => _.listAll)),
    ListWorkForChat: (req) =>
      rpcEffect("ListWorkForChat", Effect.flatMap(WorkService, (_) => _.listForChat(req.chatId))),
    ListWorkComments: (req) =>
      rpcEffect(
        "ListWorkComments",
        Effect.flatMap(WorkService, (_) => _.listComments(req.id, { allRevisions: req.allRevisions })),
      ),
    CreateWork: (req) =>
      rpcEffect(
        "CreateWork",
        Effect.flatMap(WorkService, (_) => _.create(req.input, { source: "rpc", chatId: req.chatId })),
      ),
    UpdateWorkStatus: (req) =>
      rpcEffect(
        "UpdateWorkStatus",
        Effect.flatMap(WorkService, (_) => _.updateStatus(req.id, req.status, { source: "rpc" })),
      ),
    UpdateWorkPriority: (req) =>
      rpcEffect(
        "UpdateWorkPriority",
        Effect.flatMap(WorkService, (_) => _.updatePriority(req.id, req.priority, { source: "rpc" })),
      ),
    ReviseWork: (req) =>
      rpcEffect(
        "ReviseWork",
        Effect.flatMap(WorkService, (_) => _.revise(req.id, req.edits, { source: "rpc" })),
      ),
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
