import { Context, Effect, Exit, Layer, Scope, Stream, SubscriptionRef } from "effect"
import * as Semaphore from "effect/Semaphore"
import type { ChatId, TargetId } from "../../shared/ids.js"
import type { TargetOrigin, TargetSession } from "../../shared/instance.js"
import type { ExtractedRows } from "../ingest/db/schema.js"
import type { AppServerCapability } from "../../shared/provider.js"
import type { AppServerDriver, AppServerDriverError } from "../ingest/providers/app-server-driver.js"
import type { CodexDriverOptions } from "../ingest/providers/codex-appserver/driver.js"
import { launchCodexAppServerSession } from "../ingest/providers/codex-appserver/launch.js"
import { launchCursorAcpSession } from "../ingest/providers/cursor-acp/launch.js"
import { IngestStore } from "../ingest/db/store.js"
import { CodexDriverRegistry } from "./CodexDriverRegistry.js"

/**
 * Launch a resident structured (RPC-backed) session. `command`/`args` come from
 * the provider's app-server capability (e.g. `codex` + `["app-server"]`), mapped
 * in by the caller/router, so this manager stays provider-agnostic.
 */
export interface RpcLaunchRequest {
  readonly chatId: ChatId
  readonly targetSessionId: TargetId
  /** Provider kind and launch identity — this manager owns the `TargetSession`
   * state (so it surfaces in the unified `WatchSessions`), built from these. */
  readonly provider: string
  readonly origin?: TargetOrigin
  readonly startedAt: string
  readonly cwd: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  /** Which dialect the launch command speaks — picks the driver factory. Defaults to codex. */
  readonly protocol?: AppServerCapability["protocol"]
  readonly model?: string
  readonly sandbox?: CodexDriverOptions["sandbox"]
  readonly approvalPolicy?: CodexDriverOptions["approvalPolicy"]
  /** Rejoin an existing thread by id (`thread/resume`) instead of starting fresh. */
  readonly resumeThreadId?: string
}

/**
 * The runtime owner for **RPC-backed** target sessions — the structured-process
 * sibling of the PTY-backed `TargetSessionManager`. Where that one spawns a
 * pseudo-terminal and drives it with keystrokes/paste/resize, this drives a
 * resident JSON-RPC agent: `submit` runs a turn, approvals flow through the
 * Arc-owned `CodexDriverRegistry` → answer RPC, and there is no byte stream or
 * terminal surface. `TargetSession` identity is unchanged; only the live runtime
 * differs (the renderer branches on session kind for terminal vs transcript).
 *
 * Each session gets a scope forked off the layer scope, so `stop` closes just
 * that session (killing its driver + deregistering its approvals) and app quit
 * closes them all. Today the only RPC driver is codex app-server; pi's rpc mode
 * is the same family and would join here rather than through the PTY machinery.
 */
export class RpcSessionManager extends Context.Service<
  RpcSessionManager,
  {
    /** Launch (idempotent per targetSessionId): spawn the driver, persist its
     * turns, register its approvals. Returns the `TargetSession` with its
     * `nativeSessionId` bound to the driver's thread id — the caller persists that
     * so the timeline projection can resolve the target by (provider, native id). */
    readonly launch: (req: RpcLaunchRequest) => Effect.Effect<TargetSession, AppServerDriverError>
    /** Run a user turn against a launched session. `accepted:false` if unknown;
     * `rows` is the session's cumulative rows for the caller to project. */
    readonly submit: (req: {
      readonly targetSessionId: string
      readonly text: string
    }) => Effect.Effect<
      { readonly accepted: boolean; readonly status?: string; readonly rows?: ExtractedRows },
      AppServerDriverError
    >
    /** Tear a session down: closes its scope (kills driver, deregisters approvals). */
    readonly stop: (targetSessionId: string) => Effect.Effect<{ readonly stopped: boolean }>
    /** The target session ids currently live under this manager. */
    readonly list: Effect.Effect<ReadonlyArray<string>>
    /** The live `TargetSession` states (full objects) — the router merges these
     * into the unified sessions view so rpc sessions surface in the renderer. */
    readonly sessions: Effect.Effect<ReadonlyArray<TargetSession>>
    /** Reactive view of {@link sessions}: current value, then every change. */
    readonly changes: Stream.Stream<ReadonlyArray<TargetSession>>
    /** Target ids with a turn in flight — feeds the live "generating" activity
     * (an rpc session has no hook stream, so this is its turn-lifecycle signal). */
    readonly generating: Effect.Effect<ReadonlyArray<string>>
    /** Reactive view of {@link generating}: current value, then every change. */
    readonly generatingChanges: Stream.Stream<ReadonlyArray<string>>
  }
>()("arcwork/RpcSessionManager") {}

interface LiveRpcSession {
  readonly driver: AppServerDriver
  readonly scope: Scope.Closeable
  /** Serializes turns for this session: the driver folds one turn at a time
   * (unkeyed turn outcomes), so concurrent submits would misattribute completions. */
  readonly sem: Semaphore.Semaphore
}

export const RpcSessionManagerLive = Layer.effect(
  RpcSessionManager,
  Effect.gen(function* () {
    const registry = yield* CodexDriverRegistry
    const ingest = yield* IngestStore
    const parentScope = yield* Effect.scope
    const sessions = new Map<string, LiveRpcSession>()
    // Serialize launches so the idempotency check + spawn + `sessions.set` are
    // atomic: two concurrent resumes of the same id (a double-clicked "resume")
    // would otherwise both pass the guard, both spawn a driver, and the second
    // set would orphan the first scope (a leaked process). Mirrors the PTY
    // manager's `launchLock`.
    const launchLock = yield* Semaphore.make(1)
    // Observable `TargetSession` state, so the router can fold these into the
    // unified `WatchSessions` stream — an rpc session has no PTY registry to
    // appear in, so it lives here.
    const store = yield* SubscriptionRef.make<ReadonlyMap<string, TargetSession>>(new Map())
    // Target ids with a turn in flight — the rpc equivalent of the hook-driven
    // open-turn set, read by LiveTargetStateService to paint "generating".
    const generating = yield* SubscriptionRef.make<ReadonlySet<string>>(new Set())
    const markGenerating = (id: string, on: boolean) =>
      SubscriptionRef.update(generating, (s) => {
        if (on === s.has(id)) return s
        const next = new Set(s)
        if (on) next.add(id)
        else next.delete(id)
        return next
      })

    const launch = (req: RpcLaunchRequest): Effect.Effect<TargetSession, AppServerDriverError> =>
      launchLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(store)
        const already = current.get(req.targetSessionId)
        if (already && sessions.has(req.targetSessionId)) return already // idempotent

        // Child of the layer scope: closes on `stop` or on app quit.
        const scope = yield* Scope.fork(parentScope)
        // Pick the driver factory by dialect. Both speak the newline-delimited
        // JSON-RPC transport and return the same {@link AppServerDriver}, so only
        // the handshake/fold differs — the manager below is dialect-agnostic.
        const launchSession =
          req.protocol === "acp" ? launchCursorAcpSession : launchCodexAppServerSession
        const build = Effect.gen(function* () {
          const driver = yield* launchSession(
            { launchCmd: req.command, args: req.args, protocol: req.protocol },
            {
              cwd: req.cwd,
              model: req.model,
              sandbox: req.sandbox,
              approvalPolicy: req.approvalPolicy,
              resumeThreadId: req.resumeThreadId,
            },
          )
          yield* registry.register({
            chatId: req.chatId,
            targetSessionId: req.targetSessionId,
            driver,
          })
          return driver
        }).pipe(Scope.provide(scope), Effect.provideService(IngestStore, ingest))

        const driver = yield* build.pipe(
          // A failed launch must not leak the forked scope (or a half-spawned child).
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        )
        const sem = yield* Semaphore.make(1)
        sessions.set(req.targetSessionId, { driver, scope, sem })
        const session: TargetSession = {
          _tag: "TargetSession",
          id: req.targetSessionId,
          provider: req.provider,
          origin: req.origin ?? "manual",
          chatId: req.chatId,
          cwd: req.cwd,
          nativeSessionId: driver.threadId,
          attached: true,
          runtime: "rpc",
          state: "running",
          startedAt: req.startedAt,
        }
        yield* SubscriptionRef.update(store, (m) => new Map(m).set(session.id, session))
        return session
      }),
      )

    const submit = (req: { readonly targetSessionId: string; readonly text: string }) =>
      Effect.gen(function* () {
        const session = sessions.get(req.targetSessionId)
        if (!session) return { accepted: false as const }
        // One turn at a time per session (the driver's turn outcomes are unkeyed),
        // and mark the session "generating" for the duration so the composer/sidebar
        // paint live activity the way a PTY turn does off its hooks.
        const result = yield* session.sem.withPermits(1)(
          Effect.acquireUseRelease(
            markGenerating(req.targetSessionId, true),
            () => session.driver.runTurn(req.text),
            () => markGenerating(req.targetSessionId, false),
          ),
        )
        return { accepted: true as const, status: result.status, rows: result.rows }
      })

    const stop = (targetSessionId: string) =>
      Effect.gen(function* () {
        const session = sessions.get(targetSessionId)
        if (!session) return { stopped: false }
        sessions.delete(targetSessionId)
        yield* SubscriptionRef.update(store, (m) => {
          const next = new Map(m)
          next.delete(targetSessionId)
          return next
        })
        yield* markGenerating(targetSessionId, false)
        yield* Scope.close(session.scope, Exit.void)
        return { stopped: true }
      })

    return {
      launch,
      submit,
      stop,
      list: Effect.sync(() => [...sessions.keys()]),
      sessions: SubscriptionRef.get(store).pipe(Effect.map((m) => [...m.values()])),
      changes: Stream.map(SubscriptionRef.changes(store), (m) => [...m.values()]),
      generating: SubscriptionRef.get(generating).pipe(Effect.map((s) => [...s])),
      generatingChanges: Stream.map(SubscriptionRef.changes(generating), (s) => [...s]),
    }
  }),
)
