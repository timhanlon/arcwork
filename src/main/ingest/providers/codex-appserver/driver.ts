import { Data, Effect, Option, Queue, type Scope, Stream, SubscriptionRef } from "effect"
import type { ExtractedRows } from "../../db/schema.js"
import { obj, str } from "../../extract/json.js"
import { normalizeAppServerThread } from "./normalize.js"
import { type ApprovalRequestParams, decodeApprovalParams, decodeThreadStart } from "./protocol.js"
import { type AppServerTransport, type AppServerTransportError, makeAppServerTransport } from "./transport.js"

/**
 * The codex app-server driver: the one place that knows the protocol. It owns a
 * live `codex app-server` process (via the generic transport), runs the
 * `initialize → thread/start → turn/start` handshake, folds each turn's
 * `item/completed` + `thread/tokenUsage/updated` stream into the shared
 * `ExtractedRows` (via {@link normalizeAppServerThread}), and runs the approval
 * state machine so `item/<kind>/requestApproval` server requests become a deterministic
 * pending-input signal instead of the racy `outputText`-flash inference.
 *
 * It is a *service* that owns process + thread state, not an `AgentProvider`
 * (whose `collect` is a stateless parse pass). Wire types never escape this file:
 * callers see `ExtractedRows`, a `PendingApproval` list, and a turn status.
 */
export class CodexDriverError extends Data.TaggedError("CodexDriverError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** An outstanding approval request — the pending-input signal for the app-server path. */
export interface PendingApproval {
  /** The JSON-RPC request id — the reliable routing key for `answerApproval`. */
  readonly id: number | string
  /** Codex's approval handle when present (commandExecution only) — display/correlation detail. */
  readonly approvalId: string | null
  /** Links to the exact tool-call item already in the projection. */
  readonly itemId: string | null
  readonly command: string | null
  /** Server-supplied allowable answers; the UI offers these verbatim. */
  readonly availableDecisions: ReadonlyArray<unknown>
}

export interface TurnResult {
  /** `completed` | `interrupted` | `failed` | `unknown`. */
  readonly status: string
  /** The session's cumulative rows through this turn — ready for `IngestStore.replaceSession`. */
  readonly rows: ExtractedRows
}

export interface CodexAppServerDriver {
  readonly threadId: string
  /** Send a user turn and resolve once it completes, with the session's cumulative rows + status. */
  readonly runTurn: (text: string) => Effect.Effect<TurnResult, CodexDriverError>
  /** The current outstanding approvals; subscribe via `.changes` for the live signal. */
  readonly pendingApprovals: SubscriptionRef.SubscriptionRef<ReadonlyArray<PendingApproval>>
  /** Answer an approval with a server-offered decision (pass it through verbatim). */
  readonly answerApproval: (id: number | string, decision: unknown) => Effect.Effect<void, CodexDriverError>
}

export interface CodexDriverOptions {
  readonly cwd: string
  readonly model?: string
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never"
  /** Defaults to `codex`. */
  readonly command?: string
  /** Defaults to `["app-server"]`. */
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
  readonly clientName?: string
  /** Resume an existing thread by id (`thread/resume`) instead of starting a
   * fresh one (`thread/start`). The id is a codex session id — the same one the
   * PTY path resumes with — so a session started here rejoins under its old id. */
  readonly resumeThreadId?: string
}

interface TurnOutcome {
  readonly items: ReadonlyArray<unknown>
  readonly usage: ReadonlyArray<unknown>
  readonly status: string
}

const wrap =
  (message: string) =>
  <A, R>(effect: Effect.Effect<A, AppServerTransportError, R>): Effect.Effect<A, CodexDriverError, R> =>
    effect.pipe(Effect.mapError((cause) => new CodexDriverError({ message, cause })))

export const makeCodexAppServerDriver = (
  options: CodexDriverOptions,
): Effect.Effect<CodexAppServerDriver, CodexDriverError, Scope.Scope> =>
  Effect.gen(function* () {
    const transport: AppServerTransport = yield* makeAppServerTransport({
      command: options.command ?? "codex",
      args: options.args ?? ["app-server"],
      cwd: options.cwd,
      env: options.env,
    }).pipe(wrap("failed to spawn codex app-server"))

    // Handshake: initialize → initialized → thread/start (fresh) or thread/resume
    // (rejoin an existing thread by id). Both answer with `{ thread: { id } }`, so
    // the same decoder extracts the thread id either way.
    yield* transport
      .request("initialize", {
        clientInfo: { name: options.clientName ?? "arc", title: "Arc", version: "0.0.1" },
      })
      .pipe(wrap("initialize failed"))
    yield* transport.notify("initialized", {}).pipe(wrap("initialized notify failed"))
    const threadConfig = {
      cwd: options.cwd,
      model: options.model,
      sandbox: options.sandbox,
      approvalPolicy: options.approvalPolicy,
    }
    const [method, params] = options.resumeThreadId
      ? (["thread/resume", { threadId: options.resumeThreadId, ...threadConfig }] as const)
      : (["thread/start", threadConfig] as const)
    const started = yield* transport.request(method, params).pipe(wrap(`${method} failed`))
    const thread = decodeThreadStart(started)
    if (Option.isNone(thread)) {
      return yield* Effect.fail(
        new CodexDriverError({ message: `${method} returned no thread id`, cause: started }),
      )
    }
    const threadId = thread.value.thread.id

    const pendingApprovals = yield* SubscriptionRef.make<ReadonlyArray<PendingApproval>>([])
    const turnOutcomes = yield* Queue.make<TurnOutcome>()

    // One sequential fiber folds the notification stream. Accumulation is
    // thread-cumulative, not per-turn: the store's `replaceSession` replaces a
    // session with the whole row set (the file scraper re-parses the entire
    // rollout each time), so each `turn/completed` hands `runTurn` the session's
    // rows *so far* — a snapshot copy, since the accumulators keep growing.
    // Single-consumer, so the mutable accumulators need no locking.
    const items: Array<unknown> = []
    const usage: Array<unknown> = []
    yield* transport.notifications.pipe(
      Stream.runForEach((notification) =>
        Effect.gen(function* () {
          switch (notification.method) {
            case "item/completed": {
              const item = obj(notification.params)?.["item"]
              if (item !== undefined) items.push(item)
              break
            }
            case "thread/tokenUsage/updated": {
              usage.push(notification.params)
              break
            }
            case "turn/completed": {
              const turn = obj(obj(notification.params)?.["turn"])
              const status = str(turn?.["status"]) ?? "unknown"
              yield* Queue.offer(turnOutcomes, { items: items.slice(), usage: usage.slice(), status })
              break
            }
            case "serverRequest/resolved": {
              const requestId = obj(notification.params)?.["requestId"]
              yield* SubscriptionRef.update(pendingApprovals, (list) =>
                list.filter((approval) => approval.id !== requestId),
              )
              break
            }
          }
        }),
      ),
      Effect.forkScoped,
    )

    // Approvals: record each `requestApproval` as a pending-input signal. We do
    // not auto-answer — the UI (or a headless policy) calls `answerApproval`.
    // Any other server request is answered emptily so the server never blocks.
    yield* transport.serverRequests.pipe(
      Stream.runForEach((request) =>
        Effect.gen(function* () {
          if (!request.method.endsWith("requestApproval")) {
            yield* transport.respond(request.id, {}).pipe(Effect.ignore)
            return
          }
          const params: ApprovalRequestParams = decodeApprovalParams(request.params).pipe(
            Option.getOrElse(() => ({}) as ApprovalRequestParams),
          )
          const approval: PendingApproval = {
            id: request.id,
            approvalId: params.approvalId ?? null,
            itemId: params.itemId ?? null,
            command: params.command ?? null,
            availableDecisions: params.availableDecisions ?? [],
          }
          yield* SubscriptionRef.update(pendingApprovals, (list) => [...list, approval])
        }),
      ),
      Effect.forkScoped,
    )

    const runTurn = (text: string): Effect.Effect<TurnResult, CodexDriverError> =>
      Effect.gen(function* () {
        yield* transport
          .request("turn/start", { threadId, input: [{ type: "text", text }] })
          .pipe(wrap("turn/start failed"))
        const outcome = yield* Queue.take(turnOutcomes)
        const rows = normalizeAppServerThread(outcome.items, outcome.usage, {
          nativeSessionId: threadId,
          workspaceRoot: options.cwd,
          sourcePath: `appserver:${threadId}`,
          model: options.model ?? null,
        })
        return { status: outcome.status, rows }
      })

    const answerApproval = (id: number | string, decision: unknown): Effect.Effect<void, CodexDriverError> =>
      transport
        .respond(id, { decision })
        .pipe(
          Effect.andThen(
            SubscriptionRef.update(pendingApprovals, (list) => list.filter((approval) => approval.id !== id)),
          ),
          wrap("answerApproval failed"),
        )

    return { threadId, runTurn, pendingApprovals, answerApproval }
  })
