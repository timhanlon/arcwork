import { Duration, Effect, Layer, Stream } from "effect"
import * as Atom from "effect/unstable/reactivity/Atom"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { AtomRpc } from "effect/unstable/reactivity"
import { rpc, sharedFlatRpcClient } from "./rpc-client.js"
import { ArcRpcs } from "../../shared/rpc.js"
import { arcId, type ChatId, type WorkspaceId } from "../../shared/ids.js"
import type { Work, WorkStatus } from "../../shared/work.js"

/**
 * The Effect-idiomatic reactive store for the renderer's server state. Each
 * atom wraps an effect (or a stream); the React layer reads it as an
 * `AsyncResult` (initial → waiting → success/failure) via `useAtomValue`, which
 * deletes the manual loading/error/data `useState` triads.
 *
 * The transport underneath is a real `effect/unstable/rpc` client over the
 * Electron IPC bridge (see `rpc-client.ts`): most lists below go through the
 * `AtomRpc` client (`query` / `runtime.atom`); the few `rpc()`-facade reads use
 * the same client under the hood.
 */

/**
 * One-shot control-plane reads (lazy; run on first subscription, cached).
 * `tryPromise`, not `promise`: `rpc()` rejects with `ArcRpcError` on a failed
 * call, so it must surface as a typed failure (an `AsyncResult` error the UI can
 * render) rather than a defect.
 */
export const providersAtom = Atom.make(Effect.tryPromise(() => rpc("ListProviders", undefined)))
export const presetsAtom = Atom.make(Effect.tryPromise(() => rpc("ListPresets", undefined)))

const ArcRpcAtomClient = AtomRpc.Service()("ArcRpcAtomClient", {
  group: ArcRpcs,
  protocol: Layer.empty,
  makeEffect: sharedFlatRpcClient,
})

/**
 * Side-effecting RPCs the UI triggers imperatively (not render-driven reads).
 * Each is an `AtomResultFn`: a component drives it with `useAtomSet` and the
 * call's failure lands in the same `AsyncResult` error channel as every query
 * above — no dangling promise to `.catch`, no `console.error` that can't reach a
 * backend. Callers that need this call's result (the new chat, the bound
 * session) read it via `useAtomSet(..., { mode: "promiseExit" })`, which resolves
 * to an `Exit` (never rejects) instead of throwing. `ListWorkspaceFiles` is a
 * read, but it's lazily triggered on `@`-picker open, so it's shaped the same.
 */
export const createChatAtom = ArcRpcAtomClient.mutation("CreateChat")
export const openWorkspaceAtom = ArcRpcAtomClient.mutation("OpenWorkspace")
export const launchTargetAtom = ArcRpcAtomClient.mutation("LaunchTarget")
export const resumeTargetAtom = ArcRpcAtomClient.mutation("ResumeTarget")
export const stopTargetAtom = ArcRpcAtomClient.mutation("StopTarget")
export const listWorkspaceFilesAtom = ArcRpcAtomClient.mutation("ListWorkspaceFiles")

/**
 * A renderer refresh signal sourced from a `Watch*Changes` server stream (off the
 * custom IPC push): each change descriptor increments a counter, so an atom wired
 * with `makeRefreshOnSignal` re-pulls its query on every change. `runtime.atom`
 * runs the stream on the AtomRpc runtime so the flat client (and its Electron
 * protocol) is in scope. The `Stream.scan` seed `0` matches `initialValue`, so
 * the query's own authoritative first pull isn't doubled by a boot tick — and
 * because these are signals (not lists), nothing is re-streamed on each change.
 */
const signalCount = <A>(stream: Stream.Stream<A, unknown>): Stream.Stream<number, unknown> =>
  stream.pipe(Stream.scan(0, (n) => n + 1))

export const pendingRequestsAtom = ArcRpcAtomClient.query("ListPendingRequests", undefined).pipe(
  // Pending re-derives off chat-message changes (a request appears/clears as a
  // message row), so it rides the same change stream.
  Atom.makeRefreshOnSignal(
    ArcRpcAtomClient.runtime.atom(
      Stream.unwrap(
        ArcRpcAtomClient.use((client) => Effect.succeed(signalCount(client("WatchChatMessageChanges", undefined)))),
      ),
      { initialValue: 0 },
    ),
  ),
)

/**
 * The global live lists, each moved off its custom `arc:*` IPC push onto an
 * Effect RPC server stream (`Watch*`). The main-side service backs each on a
 * `SubscriptionRef`, whose stream replays the current value on subscribe then
 * pushes every change — so the boot snapshot rides the stream itself, with no
 * `on*` listener to bridge. `runtime.atom(Stream)` runs the stream on the AtomRpc
 * runtime (so the flat client and its Electron protocol are in scope) and yields
 * the latest emitted value as an `AsyncResult`, the same shape every consumer
 * already reads. `pendingRequestsAtom` above stays on query + push-invalidation:
 * it's a derived projection with no `changes` SubscriptionRef to stream.
 */
export const sessionsAtom = ArcRpcAtomClient.runtime.atom(
  Stream.unwrap(ArcRpcAtomClient.use((client) => Effect.succeed(client("WatchSessions", undefined)))),
)
export const workspacesAtom = ArcRpcAtomClient.runtime.atom(
  Stream.unwrap(ArcRpcAtomClient.use((client) => Effect.succeed(client("WatchWorkspaces", undefined)))),
)
export const chatsAtom = ArcRpcAtomClient.runtime.atom(
  Stream.unwrap(ArcRpcAtomClient.use((client) => Effect.succeed(client("WatchChats", undefined)))),
)
export const liveTargetStatesAtom = ArcRpcAtomClient.runtime.atom(
  Stream.unwrap(ArcRpcAtomClient.use((client) => Effect.succeed(client("WatchLiveTargetStates", undefined)))),
)

const chatMessagesSignalAtom = Atom.family((chatId: string) =>
  ArcRpcAtomClient.runtime.atom(
    Stream.unwrap(
      ArcRpcAtomClient.use((client) =>
        Effect.succeed(
          signalCount(client("WatchChatMessageChanges", undefined).pipe(Stream.filter((c) => c.chatId === chatId))),
        ),
      ),
    ),
    { initialValue: 0 },
  )
)

const chatActivitySignalAtom = Atom.family((chatId: string) =>
  ArcRpcAtomClient.runtime.atom(
    Stream.unwrap(
      ArcRpcAtomClient.use((client) =>
        Effect.succeed(
          signalCount(client("WatchChatActivityChanges", undefined).pipe(Stream.filter((c) => c.chatId === chatId))),
        ),
      ),
    ),
    { initialValue: 0 },
  )
)

/**
 * One `WatchGitChanges` subscription per workspace, shared by both git signal
 * atoms below. It scans the change stream into two monotonic counters: `all` ticks
 * on every change, `repo` only on a branch/PR remap (`post-checkout`/`pre-push`
 * hook or worktree op). Sharing one upstream stream keeps the pane's IPC fan-out
 * at a single stream per workspace instead of one per derived signal.
 */
const gitChangeCountsAtom = Atom.family((workspaceId: WorkspaceId) =>
  ArcRpcAtomClient.runtime.atom(
    Stream.unwrap(
      ArcRpcAtomClient.use((client) =>
        Effect.succeed(
          client("WatchGitChanges", undefined).pipe(
            Stream.filter((c) => c.workspaceId === workspaceId),
            Stream.scan({ all: 0, repo: 0 }, (acc, c) => ({
              all: acc.all + 1,
              repo: c.kind === "repo" ? acc.repo + 1 : acc.repo,
            })),
          ),
        ),
      ),
    ),
    { initialValue: { all: 0, repo: 0 } },
  )
)

/**
 * Per-workspace git read-model refresh signal — context/commits. Derived from the
 * shared counts as the bare `repo` number (not the wrapping `AsyncResult`, whose
 * identity changes every emission), so a working-tree edit — which moves `all` but
 * not `repo` — is deduped away by the registry's `Object.is` check and never
 * re-pulls the PR context. Seed `0` matches the base initial value so the pane's
 * own first pull on mount isn't doubled by a boot tick.
 */
export const gitChangesSignalAtom = Atom.family((workspaceId: WorkspaceId) =>
  Atom.map(gitChangeCountsAtom(workspaceId), (r) => (AsyncResult.isSuccess(r) ? r.value.repo : 0)),
)

/**
 * The changed-files refresh signal. Exposes the `all` counter, so it ticks on
 * *every* git change for the workspace — both `status` (a working-tree edit,
 * surfaced by the main-side tree watcher) and `repo` (a hook/worktree remap, which
 * can also change the dirty set).
 */
const gitStatusSignalAtom = Atom.family((workspaceId: WorkspaceId) =>
  Atom.map(gitChangeCountsAtom(workspaceId), (r) => (AsyncResult.isSuccess(r) ? r.value.all : 0)),
)

/**
 * The per-workspace git read model as shared, signal-refreshed atoms: working-tree
 * status, the repo/branch→PR context, and the branch's commits. Hoisting these out
 * of the Git pane's local state lets the data survive the pane's mount/unmount and
 * be warmed before the pane opens (a subscriber keeps the active workspace's atoms
 * live). Each refreshes on {@link gitChangesSignalAtom} and retains its prior value
 * while re-pulling, so a refresh never flashes the pane empty.
 *
 * The idle TTL keeps a workspace's value (and its live signal refresh) for a window
 * after you switch away, so switching back is instant instead of a cold re-pull —
 * while still releasing workspaces you haven't touched in a while.
 */
const GIT_ATOM_TTL = Duration.minutes(5)

export const gitStatusAtom = Atom.family((workspaceId: WorkspaceId) =>
  ArcRpcAtomClient.query("GetWorkspaceGitStatus", { workspaceId }).pipe(
    Atom.makeRefreshOnSignal(gitStatusSignalAtom(workspaceId)),
    Atom.setIdleTTL(GIT_ATOM_TTL),
  )
)

export const gitContextAtom = Atom.family((workspaceId: WorkspaceId) =>
  ArcRpcAtomClient.query("GetWorkspaceGitContext", { workspaceId }).pipe(
    Atom.makeRefreshOnSignal(gitChangesSignalAtom(workspaceId)),
    Atom.setIdleTTL(GIT_ATOM_TTL),
  )
)

export const gitCommitsAtom = Atom.family((workspaceId: WorkspaceId) =>
  ArcRpcAtomClient.query("GetWorkspaceGitCommits", { workspaceId }).pipe(
    Atom.makeRefreshOnSignal(gitChangesSignalAtom(workspaceId)),
    Atom.setIdleTTL(GIT_ATOM_TTL),
  )
)

/**
 * One changed file's diff, keyed on `(workspaceId, path)` so an expanded row
 * reads its own cached value and refreshes on the same git signal as the rest of
 * the pane (an inline diff no longer goes stale beside its live-updating row).
 * Composite string key because `Atom.family` memoizes by `Equal`, which treats
 * plain-object args as reference-unique; a workspace id and a path never contain
 * a newline, so it is an unambiguous separator.
 */
const gitFileDiffKey = (workspaceId: WorkspaceId, path: string): string => `${workspaceId}\n${path}`

export const gitFileDiffAtom = Atom.family((key: string) => {
  const sep = key.indexOf("\n")
  const workspaceId = arcId("workspace", key.slice(0, sep))
  const path = key.slice(sep + 1)
  return ArcRpcAtomClient.query("GetWorkspaceGitFileDiff", { workspaceId, path }).pipe(
    Atom.makeRefreshOnSignal(gitChangesSignalAtom(workspaceId)),
    Atom.setIdleTTL(GIT_ATOM_TTL),
  )
})

export const gitFileDiffAtomFor = (workspaceId: WorkspaceId, path: string) =>
  gitFileDiffAtom(gitFileDiffKey(workspaceId, path))

/**
 * The work navigator/comments refresh signal. Work has two change sources folded
 * here: the in-app `WatchWorkChanges` stream (every real mutation, RPC or MCP,
 * runs through the same in-process `WorkService`), plus the chat activity/message
 * change streams as a coarse fallback that also refreshes when work activity
 * surfaces there. Debounced so a burst collapses to one refetch.
 */
export const workInvalidationSignalAtom = ArcRpcAtomClient.runtime.atom(
  Stream.unwrap(
    ArcRpcAtomClient.use((client) =>
      Effect.succeed(
        Stream.mergeAll(
          [
            Stream.map(client("WatchWorkChanges", undefined), () => undefined),
            Stream.map(client("WatchChatActivityChanges", undefined), () => undefined),
            Stream.map(client("WatchChatMessageChanges", undefined), () => undefined),
          ],
          { concurrency: "unbounded" },
        ).pipe(Stream.debounce(Duration.millis(250)), Stream.scan(0, (n) => n + 1)),
      ),
    ),
  ),
  { initialValue: 0 },
)

export const chatWorkAtom = Atom.family((chatId: ChatId) =>
  ArcRpcAtomClient.query("ListWorkForChat", { chatId }).pipe(
    Atom.makeRefreshOnSignal(workInvalidationSignalAtom),
  )
)

export const chatMessagesAtom = Atom.family((chatId: ChatId) =>
  ArcRpcAtomClient.query("ListChatMessages", { chatId }).pipe(
    Atom.makeRefreshOnSignal(chatMessagesSignalAtom(chatId)),
  )
)

export const chatActivityAtom = Atom.family((chatId: ChatId) =>
  ArcRpcAtomClient.query("ListChatActivity", { chatId }).pipe(
    Atom.makeRefreshOnSignal(chatActivitySignalAtom(chatId)),
  )
)

/**
 * Every unit of work in a chat's workspace, across all statuses — the work
 * navigator's list. Unlike the single-RPC lists above this is a composite read
 * (search refs, then hydrate), so it's a plain `Atom.make(Effect)` rather than
 * an `AtomRpc.query`, but it joins the same work invalidation signal.
 */
const ALL_WORK_STATUSES: ReadonlyArray<WorkStatus> = [
  "open",
  "active",
  "blocked",
  "done",
  "superseded",
]

const loadWorkspaceWork = (chatId: ChatId): Effect.Effect<ReadonlyArray<Work>, unknown> =>
  Effect.tryPromise(async () => {
    const search = await rpc("SearchArc", {
      params: { kinds: ["work"], filters: { chatId, status: ALL_WORK_STATUSES }, limit: 500 },
    })
    const refs = search.hits.map((hit) => hit.ref)
    if (refs.length === 0) return []
    const hydrated = await rpc("GetArc", { params: { refs, include: [] } })
    return hydrated.entities.flatMap((entity) => (entity._tag === "work" ? [entity.work] : []))
  })

export const allWorkAtom = Atom.family((chatId: ChatId) =>
  Atom.make(loadWorkspaceWork(chatId)).pipe(
    Atom.makeRefreshOnSignal(workInvalidationSignalAtom),
  )
)

/**
 * A work item's comment listing, keyed on the item and the all-revisions toggle
 * so flipping the toggle is a distinct query (and its own cached value). The key
 * is a composite string because `Atom.family` memoizes by `Equal`, which treats
 * plain-object args as reference-unique.
 */
const workCommentsKey = (id: string, allRevisions: boolean): string =>
  `${id}::${allRevisions ? "all" : "current"}`

export const workCommentsAtom = Atom.family((key: string) => {
  const sep = key.lastIndexOf("::")
  // The work id is flattened into the composite family key, so rebrand it here.
  const id = arcId("work", key.slice(0, sep))
  const allRevisions = key.slice(sep + 2) === "all"
  return ArcRpcAtomClient.query("ListWorkComments", { id, allRevisions }).pipe(
    Atom.makeRefreshOnSignal(workInvalidationSignalAtom),
  )
})

export const workCommentsAtomFor = (id: string, allRevisions: boolean) =>
  workCommentsAtom(workCommentsKey(id, allRevisions))
