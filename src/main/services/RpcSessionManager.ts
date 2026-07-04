import { Context, Effect, Exit, Layer, Scope, Stream, SubscriptionRef } from "effect"
import type { ChatId, TargetId } from "../../shared/ids.js"
import type { TargetOrigin, TargetSession } from "../../shared/instance.js"
import type { ExtractedRows } from "../ingest/db/schema.js"
import type {
  CodexAppServerDriver,
  CodexDriverError,
  CodexDriverOptions,
} from "../ingest/providers/codex-appserver/driver.js"
import { launchCodexAppServerSession } from "../ingest/providers/codex-appserver/launch.js"
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
    readonly launch: (req: RpcLaunchRequest) => Effect.Effect<TargetSession, CodexDriverError>
    /** Run a user turn against a launched session. `accepted:false` if unknown;
     * `rows` is the session's cumulative rows for the caller to project. */
    readonly submit: (req: {
      readonly targetSessionId: string
      readonly text: string
    }) => Effect.Effect<
      { readonly accepted: boolean; readonly status?: string; readonly rows?: ExtractedRows },
      CodexDriverError
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
  }
>()("arcwork/RpcSessionManager") {}

interface LiveRpcSession {
  readonly driver: CodexAppServerDriver
  readonly scope: Scope.Closeable
}

export const RpcSessionManagerLive = Layer.effect(
  RpcSessionManager,
  Effect.gen(function* () {
    const registry = yield* CodexDriverRegistry
    const ingest = yield* IngestStore
    const parentScope = yield* Effect.scope
    const sessions = new Map<string, LiveRpcSession>()
    // Observable `TargetSession` state, so the router can fold these into the
    // unified `WatchSessions` stream — an rpc session has no PTY registry to
    // appear in, so it lives here.
    const store = yield* SubscriptionRef.make<ReadonlyMap<string, TargetSession>>(new Map())

    const launch = (req: RpcLaunchRequest): Effect.Effect<TargetSession, CodexDriverError> =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(store)
        const already = current.get(req.targetSessionId)
        if (already && sessions.has(req.targetSessionId)) return already // idempotent

        // Child of the layer scope: closes on `stop` or on app quit.
        const scope = yield* Scope.fork(parentScope)
        const build = Effect.gen(function* () {
          const driver = yield* launchCodexAppServerSession(
            { launchCmd: req.command, args: req.args },
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
        sessions.set(req.targetSessionId, { driver, scope })
        const session: TargetSession = {
          _tag: "TargetSession",
          id: req.targetSessionId,
          provider: req.provider,
          origin: req.origin ?? "manual",
          chatId: req.chatId,
          cwd: req.cwd,
          nativeSessionId: driver.threadId,
          attached: true,
          state: "running",
          startedAt: req.startedAt,
        }
        yield* SubscriptionRef.update(store, (m) => new Map(m).set(session.id, session))
        return session
      })

    const submit = (req: { readonly targetSessionId: string; readonly text: string }) =>
      Effect.gen(function* () {
        const session = sessions.get(req.targetSessionId)
        if (!session) return { accepted: false as const }
        const result = yield* session.driver.runTurn(req.text)
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
    }
  }),
)
