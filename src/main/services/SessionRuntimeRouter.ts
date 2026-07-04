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
import { restoredSessionFromRow } from "./target-session/boot-restore.js"
import {
  type LaunchRequest,
  type ResumeRequest,
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
    /** Resume a session, into `pty` (default) or `rpc` (rejoin the app-server
     * thread by its persisted native id) per `req.runtime`. */
    readonly resume: (
      req: ResumeRequest,
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

    // Spawn the driver for an rpc launch, then persist its TargetSession row (with
    // the thread id as `nativeSessionId`) so `ingestArtifactSession` can resolve
    // the target by (provider, native id) when the caller projects a turn's rows.
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

        // If persistence fails the launch fails — but the driver is already live
        // and published in `rpc.sessions`. Tear it back down so we don't leak a
        // running session the DB (and thus a restart) knows nothing about.
        yield* db
          .upsertTargetSession({
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
          .pipe(Effect.tapError(() => rpc.stop(id)))

        return session
      })

    const launch = (req: LaunchRequest) => (req.runtime === "rpc" ? launchRpc(req) : pty.launch(req))

    // Rejoin an app-server thread by the row's persisted native id (a codex
    // session id). The session keeps its identity (same target id), so it resumes
    // where it left off — mirroring the PTY `codex resume <id>` path, just into the
    // rpc runtime instead of a terminal.
    const resumeRpc = (req: ResumeRequest) =>
      Effect.gen(function* () {
        const rows = yield* db.loadTargetSessions
        const row = rows.find((r) => r.id === req.sessionId)
        if (!row) {
          return yield* Effect.fail(arcRequestError(`No target session "${req.sessionId}" to resume`))
        }
        if (!row.nativeSessionId) {
          return yield* Effect.fail(
            arcRequestError(`Target session "${req.sessionId}" has no native session id to resume`),
          )
        }
        const spec = yield* providers.get(row.provider)
        if (!spec?.appServer) {
          return yield* Effect.fail(
            arcRequestError(`Provider "${row.provider}" has no app-server capability`),
          )
        }

        const session = yield* rpc.launch({
          chatId: row.chatId,
          targetSessionId: row.id,
          provider: row.provider,
          origin: row.origin === "orchestrated" ? "orchestrated" : "manual",
          startedAt: row.startedAt,
          cwd: row.cwd,
          command: spec.appServer.launchCmd,
          args: spec.appServer.args,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
          resumeThreadId: row.nativeSessionId,
        })
        // No cross-manager handoff: a detached session isn't held by the PTY
        // manager (the store is live-only) — it was surfaced from the DB. Launching
        // it into rpc makes it live here; the unified list's detached set (DB rows
        // minus live ids) drops it automatically because it's now a live id.
        // Flip the durable row back to running (stop/quit may have left it exited).
        yield* db
          .setTargetSessionState(row.id, "running")
          .pipe(
            Effect.tapError((e) => Effect.logWarning(`rpc resume persist failed (${row.id}): ${e}`)),
            Effect.ignore,
          )
        return session
      })

    const resume = (req: ResumeRequest) => (req.runtime === "rpc" ? resumeRpc(req) : pty.resume(req))

    const submit = (req: SubmitRequest) =>
      Effect.gen(function* () {
        if (yield* ownsRpc(req.instanceId)) {
          return yield* rpc.submit({ targetSessionId: req.instanceId, text: req.text })
        }
        return yield* pty.submit(req)
      })

    const stop = (req: StopRequest) =>
      Effect.gen(function* () {
        if (yield* ownsRpc(req.sessionId)) {
          // Mark the row exited *before* `rpc.stop` removes the session from the
          // rpc store: that removal ticks the unified `changes`, which re-reads the
          // DB for the detached set — if the row still read "running" it would
          // resurrect the just-stopped session as a detached row. Best-effort +
          // logged: a DB hiccup shouldn't fail an otherwise-good stop.
          yield* db
            .setTargetSessionState(req.sessionId, "exited")
            .pipe(
              Effect.tapError((e) => Effect.logWarning(`rpc stop persist failed (${req.sessionId}): ${e}`)),
              Effect.ignore,
            )
          return yield* rpc.stop(req.sessionId)
        }
        return yield* pty.stop(req)
      })

    // The unified view: the live sessions this process owns (PTY + rpc, disjoint
    // by id) plus the *detached* set — persisted rows not currently live and not
    // exited, read from the DB and runtime-neutral. An id is either live in one
    // manager or detached; never both, so there's no duplicate and no ownership
    // handoff. Resuming a detached session makes it live → it drops out of the
    // detached set on the next tick because its id is now in `live`.
    const unify = (live: ReadonlyArray<TargetSession>) =>
      Effect.map(
        db.loadTargetSessions.pipe(Effect.orElseSucceed(() => [])),
        (rows) => {
          const liveIds = new Set(live.map((s) => s.id))
          const detached = rows
            .filter((r) => r.state !== "exited" && !liveIds.has(r.id))
            .map(restoredSessionFromRow)
          return [...live, ...detached]
        },
      )
    // `rechunk(1)` per side so `zipLatestWith` tracks each list emission
    // individually; both sides replay their current value on subscribe, so the
    // union is live from the first pull. Each tick re-reads the DB for the
    // detached set (cheap; only on a session change).
    const sessions = Effect.zipWith(pty.list, rpc.sessions, (a, b) => [...a, ...b]).pipe(Effect.flatMap(unify))
    const changes = pty.changes.pipe(
      Stream.rechunk(1),
      Stream.zipLatestWith(Stream.rechunk(rpc.changes, 1), (a, b) => [...a, ...b]),
      Stream.mapEffect(unify),
    )

    return { launch, resume, submit, stop, ownsRpc, sessions, changes }
  }),
)
