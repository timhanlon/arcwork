import { Context, Effect, Layer, type Scope, Stream, SubscriptionRef } from "effect"
import type {
  CodexAppServerDriver,
  CodexDriverError,
  PendingApproval,
} from "../ingest/providers/codex-appserver/driver.js"

/** The live approvals awaiting an answer for one session. */
export interface SessionApprovals {
  readonly chatId: string
  readonly targetSessionId: string
  readonly approvals: ReadonlyArray<PendingApproval>
}

/**
 * Owns the live `codex app-server` drivers keyed by `targetSessionId`, so the
 * app-server path has an answer surface a PTY session never needed: it
 * aggregates every driver's `pendingApprovals` into one reactive list the
 * renderer signal + inline approval card read, and routes `AnswerApproval` back
 * to the right driver's `answerApproval`.
 *
 * `register` is scoped to the caller (the session launch): the mirror fiber and
 * the deregistration finalizer live in that scope, so a driver whose session
 * ends drops out of the aggregate automatically — no stale approvals.
 */
export class CodexDriverRegistry extends Context.Service<
  CodexDriverRegistry,
  {
    /** Register a driver for a session; deregisters when the caller's scope closes. */
    readonly register: (params: {
      readonly chatId: string
      readonly targetSessionId: string
      readonly driver: CodexAppServerDriver
    }) => Effect.Effect<void, never, Scope.Scope>
    /** Route an approval answer (by JSON-RPC request id) to the session's driver. */
    readonly answerApproval: (
      targetSessionId: string,
      requestId: number | string,
      decision: unknown,
    ) => Effect.Effect<void, CodexDriverError>
    /** Sessions with outstanding approvals (empty sessions omitted). */
    readonly pending: Effect.Effect<ReadonlyArray<SessionApprovals>>
    /** Reactive view of `pending`: the current aggregate, then every change. */
    readonly changes: Stream.Stream<ReadonlyArray<SessionApprovals>>
  }
>()("arcwork/CodexDriverRegistry") {}

export const CodexDriverRegistryLive = Layer.effect(
  CodexDriverRegistry,
  Effect.gen(function* () {
    const drivers = new Map<string, { readonly chatId: string; readonly driver: CodexAppServerDriver }>()
    const current = new Map<string, SessionApprovals>()
    const state = yield* SubscriptionRef.make<ReadonlyArray<SessionApprovals>>([])

    // Publish only sessions that actually have approvals — the aggregate is the
    // attention signal, so an emptied session should disappear from it.
    const republish = () =>
      SubscriptionRef.set(
        state,
        [...current.values()].filter((s) => s.approvals.length > 0),
      )

    const register = (params: {
      readonly chatId: string
      readonly targetSessionId: string
      readonly driver: CodexAppServerDriver
    }) =>
      Effect.gen(function* () {
        const { chatId, targetSessionId, driver } = params
        drivers.set(targetSessionId, { chatId, driver })

        // Mirror the driver's live approvals into the aggregate. `changes` on a
        // SubscriptionRef replays its current value, so the initial (usually
        // empty) state is reflected immediately.
        yield* SubscriptionRef.changes(driver.pendingApprovals).pipe(
          Stream.runForEach((approvals) =>
            Effect.gen(function* () {
              current.set(targetSessionId, { chatId, targetSessionId, approvals })
              yield* republish()
            }),
          ),
          Effect.forkScoped,
        )

        // Drop the session from the aggregate when its launch scope closes.
        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            drivers.delete(targetSessionId)
            current.delete(targetSessionId)
            yield* republish()
          }),
        )
      })

    const answerApproval = (targetSessionId: string, requestId: number | string, decision: unknown) =>
      Effect.gen(function* () {
        const entry = drivers.get(targetSessionId)
        if (!entry) {
          // No live driver: the session ended or was never app-server-driven.
          // Nothing to answer — a stale click is a no-op, not an error.
          return
        }
        yield* entry.driver.answerApproval(requestId, decision)
      })

    return {
      register,
      answerApproval,
      pending: SubscriptionRef.get(state),
      changes: SubscriptionRef.changes(state),
    }
  }),
)
