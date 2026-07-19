import { Data, Schema } from "effect"
import { Rpc, RpcGroup } from "effect/unstable/rpc"
import { ChatId, TargetId, WorkId, WorkspaceId } from "./ids.js"
import { Provider, ProviderSpec } from "./provider.js"
import { Preset } from "./preset.js"
import { Chat } from "./chat.js"
import { ActivityEvent } from "./activity-event.js"
import { ChatMessage } from "./chat-message.js"
import { ChatSummary } from "./chat-summary.js"
import { GitCommit, GitFileDiff, GitStatus, PullRequest, Worktree, WorkspaceGitContext } from "./git.js"
import { PendingRequest } from "./chat-request.js"
import { AppServerApproval } from "./codex-approval.js"
import { Instance, TargetSession } from "./instance.js"
import { LiveTargetState } from "./live-target-state.js"
import { ArcGetParams, ArcGetResult, ArcSearchParams, ArcSearchResult } from "./read.js"
import { Workspace } from "./workspace.js"
import {
  Work,
  WorkChange,
  WorkCommentListing,
  WorkCreateInput,
  WorkPriority,
  WorkReviseInput,
  WorkStatus,
} from "./work.js"

/**
 * The typed main<->renderer seam, defined once as an `effect/unstable/rpc`
 * `RpcGroup`. `ArcRpcs` is the *single source of truth*: every tag's payload,
 * success, and error schema lives here, and the renderer client type, the main
 * handler table, and the on-the-wire encoding are all derived from it. There is
 * no parallel request union or response-schema map to keep in lockstep.
 *
 * The transport is a real Effect RPC client/server pair over Electron IPC (see
 * `main/rpc-transport.ts` and `renderer/src/rpc-client.ts`): the renderer client
 * encodes each request via the rpc's payload schema, ships the encoded envelope
 * across `ipcRenderer.send`, and the main `RpcServer` decodes it, runs the
 * handler, and ships the encoded exit back over `webContents.send`. Both
 * directions cross only structured-clone-safe encoded objects — no bespoke
 * `RpcEnvelope`, no dynamic decode-by-tag.
 */

/** Renderer -> main: encoded RPC client messages (requests, acks). */
export const RPC_CHANNEL = "arc:rpc"
/** Main -> renderer: encoded RPC server messages (exits, defects). */
export const RPC_REPLY_CHANNEL = "arc:rpc-reply"

/**
 * Raw data-plane IPC channels (not the typed RPC seam): PTY bytes/exits and the
 * ephemeral assistant-token stream. Named here so main (the broadcaster) and the
 * preload bridge (the subscriber) can't drift on a bare string literal — a typo
 * on either side would fail silently (an empty terminal, no error).
 */
export const PTY_DATA_CHANNEL = "arc:pty-data"
export const PTY_EXIT_CHANNEL = "arc:pty-exit"
export const PTY_WRITE_CHANNEL = "arc:pty-write"
export const PTY_RESIZE_CHANNEL = "arc:pty-resize"
export const PTY_REPLAYED_CHANNEL = "arc:pty-replayed"
export const PTY_DROPPED_CHANNEL = "arc:pty-dropped"
export const ASSISTANT_STREAM_CHANNEL = "arc:assistant-stream"

/** Fire-and-forget renderer→main: hand an absolute filesystem path to the OS
 * opener (`shell.openPath`). Used when a transcript file link lands outside every
 * open workspace, so it can't open in the in-app editor. Doing this over an
 * explicit channel — rather than letting the anchor navigate and relying on the
 * `will-navigate` guard — keeps it working in `pnpm dev`, where a root-relative
 * href resolves against `http://localhost`, not `file://`. */
export const OPEN_PATH_CHANNEL = "arc:open-path"

/**
 * Typed error returned across the seam. `ArcRequestError` is an expected,
 * user-facing condition (unknown chat, target not running, empty prompt...);
 * `ArcUnexpectedError` is everything else (a SqlError, a defect) collapsed to a
 * message. Either way the renderer gets a structured value, never a raw thrown
 * Electron IPC error whose message reads `Error invoking remote method ...`.
 */
export const RpcError = Schema.Struct({
  _tag: Schema.Literals(["ArcRequestError", "ArcUnexpectedError"]),
  message: Schema.String,
})
export type RpcError = typeof RpcError.Type

/** Error thrown by the renderer `rpc()` facade when a call fails. `_tag` is always
 * `"ArcRpcError"`; `kind` preserves which side of the seam failed (an expected
 * `ArcRequestError` vs a collapsed `ArcUnexpectedError`). */
export class ArcRpcError extends Data.TaggedError("ArcRpcError")<{
  readonly kind: RpcError["_tag"]
  readonly message: string
}> {}

// --- Success schemas that aren't a bare domain type or `Array(domain)`. ---

/** A `{ workspace? }` envelope so the seam never carries null. */
const WorkspaceResult = Schema.Struct({ workspace: Schema.optional(Workspace) })

const LocalModelStatus = Schema.Struct({
  enabled: Schema.Boolean,
  provider: Schema.Literal("lmstudio"),
  baseUrl: Schema.String,
  model: Schema.NullOr(Schema.String),
  reachable: Schema.Boolean,
  message: Schema.String,
})

/** Per-provider artifact ingest counts, shared by the two ingest results. */
const IngestSummary = Schema.Struct({
  provider: Provider,
  sessions: Schema.Number,
  messages: Schema.Number,
  toolCalls: Schema.Number,
  fileHints: Schema.Number,
  diagnostics: Schema.Number,
  skipped: Schema.Number,
})

const ReprojectResult = Schema.Struct({ deleted: Schema.Number, inserted: Schema.Number })

/**
 * The workspace's files for the composer's `@` reference picker — relative POSIX
 * paths, capped main-side. `truncated` is true when the cap was hit, so the
 * picker can say the list is partial instead of implying it's the whole tree.
 */
export const WorkspaceFiles = Schema.Struct({
  files: Schema.Array(Schema.String),
  truncated: Schema.Boolean,
})
export type WorkspaceFiles = typeof WorkspaceFiles.Type

/**
 * One workspace file's contents, for the editor's read-only view. `path` is the
 * relative POSIX path the caller asked for (echoed so the renderer can key on
 * it). `text` is the decoded UTF-8 body; it is empty when `binary` is true (we
 * don't ship raw bytes over the seam to render as text) or when `truncated`
 * capped an oversized file. `truncated` says the body was cut at the size
 * ceiling so the editor can flag the view as partial rather than imply it's
 * whole; `binary` says the file looked non-text (a NUL byte in the head) so the
 * editor can show a placeholder instead of mojibake.
 */
export const WorkspaceFileContent = Schema.Struct({
  path: Schema.String,
  text: Schema.String,
  truncated: Schema.Boolean,
  binary: Schema.Boolean,
})
export type WorkspaceFileContent = typeof WorkspaceFileContent.Type

// "all" (sweep every provider) plus each provider, derived from the canonical
// union so a new provider can't be added there and silently omitted here.
const IngestKinds = Schema.Union([Schema.Literal("all"), Provider])

/**
 * Lightweight change descriptors for the `Watch*Changes` signal streams. These
 * carry *that* something changed (and which chat/ref), not the changed data —
 * the renderer re-pulls the affected list via its normal query. Keeping the
 * signal tiny is the point: a high-frequency channel (chat messages during a
 * turn) must not re-stream a whole list on every tick.
 */
const ChatChange = Schema.Struct({ chatId: ChatId })
// `kind` separates the two reasons the git read model moves: `status` is a
// working-tree edit (refresh the changed-files list only); `repo` is a branch/PR
// remap from a hook or worktree op (refresh context/commits too). The renderer
// filters on it so a high-frequency edit signal never re-pulls the PR context.
const GitChange = Schema.Struct({
  workspaceId: WorkspaceId,
  kind: Schema.Literals(["status", "repo"]),
})

/**
 * The contract. Each `Rpc.make` carries its own payload + success + error, so
 * adding a door onto a service is one entry here and one handler in
 * `main/rpc.ts` — nothing else.
 */
export const ArcRpcs = RpcGroup.make(
  Rpc.make("ListWorkspaces", { success: Schema.Array(Workspace), error: RpcError }),
  /** Live workspace list as a server stream — see `WatchSessions`. */
  Rpc.make("WatchWorkspaces", { success: Schema.Array(Workspace), error: RpcError, stream: true }),
  Rpc.make("OpenWorkspace", { success: WorkspaceResult, error: RpcError }),
  Rpc.make("ListProviders", { success: Schema.Array(ProviderSpec), error: RpcError }),
  /**
   * Files under a workspace, for the composer's `@` reference picker. Named by
   * workspace *id* — main resolves the root from its persisted list rather than
   * trusting a path off the wire.
   */
  Rpc.make("ListWorkspaceFiles", {
    payload: { workspaceId: WorkspaceId },
    success: WorkspaceFiles,
    error: RpcError,
  }),
  /**
   * One file's contents for the editor's read-only view. Like `ListWorkspaceFiles`
   * the file is named by workspace *id* + relative path: main resolves the root
   * from its persisted list and confirms the resolved real path stays inside it,
   * so a `../` escape off the wire can't read arbitrary disk. Oversized files are
   * truncated and non-text files come back flagged, not as raw bytes.
   */
  Rpc.make("ReadWorkspaceFile", {
    payload: { workspaceId: WorkspaceId, path: Schema.String },
    success: WorkspaceFileContent,
    error: RpcError,
  }),
  Rpc.make("GetWorkspaceGitStatus", {
    payload: { workspaceId: WorkspaceId },
    success: GitStatus,
    error: RpcError,
  }),
  Rpc.make("GetWorkspaceGitFileDiff", {
    payload: { workspaceId: WorkspaceId, path: Schema.String },
    success: GitFileDiff,
    error: RpcError,
  }),
  /** Recent commits on the workspace's current branch (newest first), for the Git
   * pane's history list. Local read; `limit` caps the count (default applied in
   * the service). */
  Rpc.make("GetWorkspaceGitCommits", {
    payload: { workspaceId: WorkspaceId, limit: Schema.optional(Schema.Number) },
    success: Schema.Array(GitCommit),
    error: RpcError,
  }),
  /**
   * The workspace's git context — clone identity, worktrees, current branch, and
   * the PR that branch maps to. Read-only and local: it runs repo detection (git
   * plumbing) to populate the read model but does NOT hit the network, so it's
   * safe to call on Git-pane open. `SyncWorkspacePullRequests` is the explicit
   * network refresh.
   */
  Rpc.make("GetWorkspaceGitContext", {
    payload: { workspaceId: WorkspaceId },
    success: WorkspaceGitContext,
    error: RpcError,
  }),
  /** Refresh the repository's pull requests from GitHub via `gh` and return the
   * persisted rows. The one network call in the git surface — caller-triggered. */
  Rpc.make("SyncWorkspacePullRequests", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Array(PullRequest),
    error: RpcError,
  }),
  /** Create an arc-managed worktree for a branch under the workspace's repo.
   * `createBranch` cuts a new branch off `baseRef` (default branch when omitted).
   * `carryChanges` moves the source worktree's dirty tracked/untracked changes
   * into the new worktree via a temporary git stash; repositories with no commits
   * cannot carry changes because Git cannot stash without a base commit. */
  Rpc.make("CreateWorktree", {
    payload: {
      workspaceId: WorkspaceId,
      branch: Schema.String,
      baseRef: Schema.optional(Schema.String),
      createBranch: Schema.optional(Schema.Boolean),
      carryChanges: Schema.optional(Schema.Boolean),
    },
    success: Worktree,
    error: RpcError,
  }),
  /** Open an existing worktree path as a workspace (no dialog). */
  Rpc.make("OpenWorktree", {
    payload: { worktreePath: Schema.String },
    success: Workspace,
    error: RpcError,
  }),
  /** Remove a worktree (`git worktree remove`); `force` overrides a dirty tree. */
  Rpc.make("RemoveWorktree", {
    payload: {
      workspaceId: WorkspaceId,
      worktreePath: Schema.String,
      force: Schema.optional(Schema.Boolean),
    },
    success: Schema.Struct({ removed: Schema.Boolean }),
    error: RpcError,
  }),
  /** Prune missing worktrees and reconcile the read model; returns the count. */
  Rpc.make("PruneWorktrees", {
    payload: { workspaceId: WorkspaceId },
    success: Schema.Struct({ removed: Schema.Number }),
    error: RpcError,
  }),
  /** Open a GitHub PR for the workspace's current branch via `gh pr create`,
   * then sync it into the read model. */
  Rpc.make("CreatePullRequest", {
    payload: {
      workspaceId: WorkspaceId,
      title: Schema.optional(Schema.String),
      body: Schema.optional(Schema.String),
      base: Schema.optional(Schema.String),
      draft: Schema.optional(Schema.Boolean),
    },
    success: Schema.NullOr(PullRequest),
    error: RpcError,
  }),
  Rpc.make("ListPresets", { success: Schema.Array(Preset), error: RpcError }),
  Rpc.make("ListInstances", { success: Schema.Array(Instance), error: RpcError }),
  /** Pull the live session list — the one-shot floor for non-reactive callers. */
  Rpc.make("ListSessions", { success: Schema.Array(TargetSession), error: RpcError }),
  /**
   * The live session list as a server stream: emits the current snapshot on
   * subscribe (the main-side `SubscriptionRef` replays its value), then every
   * change. This is the first list moved off the custom `arc:sessions` IPC push
   * onto an Effect RPC stream — the renderer maps it into a latest-value stream
   * atom, so the boot snapshot rides the stream rather than a separate push +
   * one-shot pull. Streaming RPC over the same Electron IPC transport (ack-based
   * chunking); see `main/rpc.ts` for the handler.
   */
  Rpc.make("WatchSessions", {
    success: Schema.Array(TargetSession),
    error: RpcError,
    stream: true,
  }),
  Rpc.make("ListChats", { success: Schema.Array(Chat), error: RpcError }),
  /** Live chat list as a server stream — see `WatchSessions`. */
  Rpc.make("WatchChats", { success: Schema.Array(Chat), error: RpcError, stream: true }),
  Rpc.make("TestLocalModel", { success: LocalModelStatus, error: RpcError }),
  /** Pull the cross-chat pending-request list — the query refreshed by `WatchChatMessageChanges`. */
  Rpc.make("ListPendingRequests", { success: Schema.Array(PendingRequest), error: RpcError }),
  /** Pull the live target-activity projection — the one-shot floor under `WatchLiveTargetStates`. */
  Rpc.make("ListLiveTargetStates", { success: Schema.Array(LiveTargetState), error: RpcError }),
  /** Live target-activity projection as a server stream — see `WatchSessions`. */
  Rpc.make("WatchLiveTargetStates", {
    success: Schema.Array(LiveTargetState),
    error: RpcError,
    stream: true,
  }),
  /** Outstanding codex app-server approvals — the one-shot floor under `WatchAppServerApprovals`. */
  Rpc.make("ListAppServerApprovals", { success: Schema.Array(AppServerApproval), error: RpcError }),
  /** Live codex app-server approvals as a server stream (the inline-card answer surface). */
  Rpc.make("WatchAppServerApprovals", {
    success: Schema.Array(AppServerApproval),
    error: RpcError,
    stream: true,
  }),
  /** Answer a codex app-server approval by echoing a decision's `payload` back verbatim. */
  Rpc.make("AnswerAppServerApproval", {
    payload: {
      targetSessionId: Schema.String,
      requestId: Schema.Union([Schema.String, Schema.Number]),
      decisionPayload: Schema.String,
    },
    success: Schema.Void,
    error: RpcError,
  }),
  /** Renderer door onto the same unified read surface as MCP `arc.search`. */
  Rpc.make("SearchArc", {
    payload: { params: ArcSearchParams },
    success: ArcSearchResult,
    error: RpcError,
  }),
  /** Renderer door onto the same unified read surface as MCP `arc.get`. */
  Rpc.make("GetArc", {
    payload: { params: ArcGetParams },
    success: ArcGetResult,
    error: RpcError,
  }),
  Rpc.make("CreateChat", {
    payload: { workspaceId: WorkspaceId, title: Schema.optional(Schema.String) },
    success: Chat,
    error: RpcError,
  }),
  Rpc.make("UpdateChatTitle", {
    payload: { chatId: ChatId, title: Schema.String },
    success: Chat,
    error: RpcError,
  }),
  Rpc.make("ListChatActivity", {
    payload: { chatId: ChatId },
    success: Schema.Array(ActivityEvent),
    error: RpcError,
  }),
  Rpc.make("ListChatMessages", {
    payload: { chatId: ChatId },
    success: Schema.Array(ChatMessage),
    error: RpcError,
  }),
  /** Distill a chat's message timeline into a structured summary via the local
   * LM Studio model and persist it as a `summary` graph node. Manual trigger; a
   * re-distill with identical inputs returns the existing summary. Minutes-long
   * when it calls the model. */
  Rpc.make("DistillChatSummary", {
    payload: { chatId: ChatId },
    success: ChatSummary,
    error: RpcError,
  }),
  /** The chat's most recently persisted summary, or null when none exists. */
  Rpc.make("GetChatSummary", {
    payload: { chatId: ChatId },
    success: Schema.NullOr(ChatSummary),
    error: RpcError,
  }),
  /**
   * Invalidation signal streams (off the custom `arc:chat-*` / `arc:work` IPC
   * push). Each forwards a service's change PubSub as a server stream of tiny
   * descriptors; the renderer maps them to a refresh tick for its queries
   * (`makeRefreshOnSignal`). Pending-requests and the work navigator re-derive
   * off chat-message changes, so they ride `WatchChatMessageChanges` too.
   */
  Rpc.make("WatchChatMessageChanges", { success: ChatChange, error: RpcError, stream: true }),
  Rpc.make("WatchChatActivityChanges", { success: ChatChange, error: RpcError, stream: true }),
  Rpc.make("WatchWorkChanges", { success: WorkChange, error: RpcError, stream: true }),
  /** Git read-model invalidation: a hook-driven branch remap or PR sync touched
   * a workspace's repo/PR state — the Git pane re-pulls `GetWorkspaceGitContext`. */
  Rpc.make("WatchGitChanges", { success: GitChange, error: RpcError, stream: true }),
  Rpc.make("ReprojectChatMessages", {
    payload: { chatId: ChatId },
    success: ReprojectResult,
    error: RpcError,
  }),
  Rpc.make("ReingestWorkspaceArtifacts", {
    payload: { workspace: Schema.String, provider: Schema.optional(IngestKinds) },
    success: Schema.Array(IngestSummary),
    error: RpcError,
  }),
  Rpc.make("ReingestAndReprojectChatMessages", {
    payload: { chatId: ChatId, provider: Schema.optional(IngestKinds) },
    success: Schema.Struct({ ingest: Schema.Array(IngestSummary), reproject: ReprojectResult }),
    error: RpcError,
  }),
  Rpc.make("LaunchTarget", {
    payload: {
      provider: Schema.String,
      chatId: ChatId,
      /** Which live runtime backs the session — `pty` (terminal TUI, default) or
       * `rpc` (app-server). A launch-time intent, not a provider property. */
      runtime: Schema.optional(Schema.Literals(["pty", "rpc"])),
      /** Diff endpoint to run in — the worker writes here and hooks/file refs
       * resolve against it. Omit to use the chat's own workspace. */
      workspaceId: Schema.optional(WorkspaceId),
      /** draft prompt to seed the session (prefill flag / env / stdin per provider) */
      prompt: Schema.optional(Schema.String),
      preset: Schema.optional(Schema.String),
      /** Renderer-measured grid size (xterm FitAddon) to spawn at — Ink reads `stdout.columns` once at startup and cannot reflow scrollback on later resize; omit for 80×24. */
      cols: Schema.optional(Schema.Number),
      rows: Schema.optional(Schema.Number),
    },
    success: TargetSession,
    error: RpcError,
  }),
  Rpc.make("ResumeTarget", {
    payload: {
      sessionId: TargetId,
      /** Which runtime to resume into — `pty` (terminal, default) or `rpc`
       * (rejoin the app-server thread). A resume-time intent, not a session
       * property: the same codex session resumes in either transport. */
      runtime: Schema.optional(Schema.Literals(["pty", "rpc"])),
      cols: Schema.optional(Schema.Number),
      rows: Schema.optional(Schema.Number),
    },
    success: TargetSession,
    error: RpcError,
  }),
  /**
   * Stop a running target: signal the live child to terminate. Graceful by
   * policy (SIGTERM, then SIGKILL after a grace window) — the manager owns the
   * escalation. Only the process holding the live PTY can stop it, so this is a
   * no-op (`stopped: false`) for a session that's already exited or detached.
   */
  Rpc.make("StopTarget", {
    payload: { sessionId: TargetId },
    success: Schema.Struct({ stopped: Schema.Boolean }),
    error: RpcError,
  }),
  Rpc.make("SubmitPrompt", {
    payload: { instanceId: TargetId, text: Schema.String },
    success: Schema.Struct({ accepted: Schema.Boolean }),
    error: RpcError,
  }),
  Rpc.make("SendChatPrompt", {
    payload: { chatId: ChatId, targetSessionId: TargetId, text: Schema.String },
    success: ChatMessage,
    error: RpcError,
  }),
  /**
   * The work API over the renderer seam — the same `WorkService` the MCP work
   * tools call, just a different door. `CreateWork` carries authored intent; arc
   * derives provenance (source `rpc`, plus any `chatId` the UI supplies).
   */
  Rpc.make("ListWork", { success: Schema.Array(Work), error: RpcError }),
  Rpc.make("ListAllWork", { success: Schema.Array(Work), error: RpcError }),
  Rpc.make("ListWorkForChat", {
    payload: { chatId: ChatId },
    success: Schema.Array(Work),
    error: RpcError,
  }),
  Rpc.make("ListWorkComments", {
    payload: { id: WorkId, allRevisions: Schema.optional(Schema.Boolean) },
    success: WorkCommentListing,
    error: RpcError,
  }),
  Rpc.make("CreateWork", {
    payload: { input: WorkCreateInput, chatId: Schema.optional(ChatId) },
    success: Work,
    error: RpcError,
  }),
  Rpc.make("UpdateWorkStatus", {
    payload: { id: WorkId, status: WorkStatus },
    success: Work,
    error: RpcError,
  }),
  Rpc.make("UpdateWorkPriority", {
    payload: { id: WorkId, priority: WorkPriority },
    success: Work,
    error: RpcError,
  }),
  Rpc.make("ReviseWork", {
    payload: { id: WorkId, edits: WorkReviseInput },
    success: Work,
    error: RpcError,
  }),
)

// --- Contract types, derived from `ArcRpcs` (the single source). ---

export type ArcRpc = RpcGroup.Rpcs<typeof ArcRpcs>
