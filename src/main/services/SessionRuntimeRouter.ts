import { Clock, Context, Effect, Layer, Stream } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { newArcId } from "../../shared/ids.js"
import type { TargetSession } from "../../shared/instance.js"
import { ArcStore } from "../db/store.js"
import type { ExtractedRows } from "../ingest/db/schema.js"
import type { CodexDriverError } from "../ingest/providers/codex-appserver/driver.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { ChatService } from "./ChatService.js"
import { ProviderRegistry } from "./ProviderRegistry.js"
import { RpcSessionManager } from "./RpcSessionManager.js"
import {
  type LaunchRequest,
  type StopRequest,
  type SubmitRequest,
  TargetSessionManager,
} from "./TargetSessionManager.js"
import { WorkspaceService } from "./WorkspaceService.js"

/**
 * Dispatches launch/submit/stop across the two session runtimes — the PTY
 * `TargetSessionManager` and the RPC-backed `RpcSessionManager` — so the rest of
 * the app has one door. Launch picks the runtime by **intent** (`req.runtime`),
 * never by provider identity: codex declares both `interactive` and `appServer`,
 * so it can be launched either way. Submit/stop route by *ownership* (which
 * manager holds the id), which needs no persisted kind.
 *
 * The router deliberately does NOT project rpc turns into the chat timeline
 * itself — that would require depending on `ChatMessageService`, which depends
 * back on the router (`sendPrompt`). Instead `submit` returns the turn's `rows`
 * and the caller (`sendPrompt`) projects them, keeping the dependency acyclic.
 */
export class SessionRuntimeRouter extends Context.Service<
  SessionRuntimeRouter,
  {
    readonly launch: (
      req: LaunchRequest,
    ) => Effect.Effect<TargetSession, ArcRequestError | SqlError | CodexDriverError>
    /** Route a submit; `rows` is present for an rpc turn (caller projects it). */
    readonly submit: (
      req: SubmitRequest,
    ) => Effect.Effect<{ readonly accepted: boolean; readonly rows?: ExtractedRows }, CodexDriverError>
    readonly stop: (req: StopRequest) => Effect.Effect<{ readonly stopped: boolean }>
    /** Whether an rpc runtime owns this session id (used to skip PTY-only checks). */
    readonly ownsRpc: (targetSessionId: string) => Effect.Effect<boolean>
    /** The unified session list — PTY + rpc — backing `ListSessions`. */
    readonly sessions: Effect.Effect<ReadonlyArray<TargetSession>>
    /** Reactive union of both managers' change streams, backing `WatchSessions`. */
    readonly changes: Stream.Stream<ReadonlyArray<TargetSession>>
  }
>()("arcwork/SessionRuntimeRouter") {}

export const SessionRuntimeRouterLive = Layer.effect(
  SessionRuntimeRouter,
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry
    const workspaces = yield* WorkspaceService
    const chats = yield* ChatService
    const db = yield* ArcStore
    const pty = yield* TargetSessionManager
    const rpc = yield* RpcSessionManager

    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
    const ownsRpc = (id: string) => Effect.map(rpc.list, (ids) => ids.includes(id))

    // Create + persist a TargetSession row for an rpc launch, spawn the driver,
    // and bind the thread id so `ingestArtifactSession` can find the target when
    // the caller projects a turn's rows.
    const launchRpc = (req: LaunchRequest) =>
      Effect.gen(function* () {
        const spec = yield* providers.get(req.provider)
        if (!spec?.appServer) {
          return yield* Effect.fail(
            arcRequestError(`Provider "${req.provider}" has no app-server capability`),
          )
        }
        const chat = yield* chats.get(req.chatId)
        const workspace = yield* workspaces.get(req.workspaceId ?? chat.workspaceId)
        const cwd = workspace.path
        const id = newArcId("target")
        const startedAt = yield* nowIso

        // The manager owns the live TargetSession (with the thread id bound), so it
        // surfaces in the unified `sessions`/`changes` below. We persist that row —
        // `nativeSessionId` = the thread id — so `ingestArtifactSession` can resolve
        // the target by (provider, native id) when a turn projects. (No `bindNative`:
        // that's the PTY store's op and no-ops for an rpc target.)
        const session = yield* rpc.launch({
          chatId: req.chatId,
          targetSessionId: id,
          provider: req.provider,
          origin: req.origin ?? "manual",
          startedAt,
          cwd,
          command: spec.appServer.launchCmd,
          args: spec.appServer.args,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
        })

        yield* db.upsertTargetSession({
          id,
          chatId: req.chatId,
          provider: req.provider,
          origin: req.origin ?? "manual",
          spawnedBy: req.spawnedBy ?? null,
          preset: req.preset ?? null,
          cwd,
          nativeSessionId: session.nativeSessionId ?? null,
          nativeTranscriptPath: null,
          state: "running",
          startedAt,
        })

        return session
      })

    const launch = (req: LaunchRequest) => (req.runtime === "rpc" ? launchRpc(req) : pty.launch(req))

    const submit = (req: SubmitRequest) =>
      Effect.gen(function* () {
        if (yield* ownsRpc(req.instanceId)) {
          return yield* rpc.submit({ targetSessionId: req.instanceId, text: req.text })
        }
        return yield* pty.submit(req)
      })

    const stop = (req: StopRequest) =>
      Effect.gen(function* () {
        if (yield* ownsRpc(req.sessionId)) return yield* rpc.stop(req.sessionId)
        return yield* pty.stop(req)
      })

    // The unified view over both runtimes. `rechunk(1)` per side so `zipLatestWith`
    // tracks each list emission individually (it zips per-element within a chunk),
    // and both sides emit their current value on subscribe, so the union is live
    // from the first pull.
    const sessions = Effect.zipWith(pty.list, rpc.sessions, (a, b) => [...a, ...b])
    const changes = pty.changes.pipe(
      Stream.rechunk(1),
      Stream.zipLatestWith(Stream.rechunk(rpc.changes, 1), (a, b) => [...a, ...b]),
    )

    return { launch, submit, stop, ownsRpc, sessions, changes }
  }),
)
