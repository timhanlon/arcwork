import { Data, type Effect, type SubscriptionRef } from "effect"
import type { ExtractedRows } from "../db/schema.js"

/**
 * The dialect-neutral contract every resident RPC agent driver implements. Two
 * dialects speak it today: `codex app-server` (thread/turn/item — see
 * `codex-appserver/driver.ts`) and Cursor's ACP (session/prompt/update — see
 * `cursor-acp/driver.ts`). Both fold a live JSON-RPC process into the same
 * {@link ExtractedRows} the rollout-file scrapers produce, surface an approval
 * signal, and answer it — so the {@link RpcSessionManager}/{@link CodexDriverRegistry}
 * seam holds one interface and picks the dialect by `AppServerCapability.protocol`.
 */
export class AppServerDriverError extends Data.TaggedError("AppServerDriverError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

/** An outstanding approval request — the pending-input signal for the app-server path. */
export interface PendingApproval {
  /** The JSON-RPC request id — the reliable routing key for `answerApproval`. */
  readonly id: number | string
  /** Dialect approval handle when present (codex commandExecution only) — display/correlation detail. */
  readonly approvalId: string | null
  /** Links to the exact tool-call item already in the projection. */
  readonly itemId: string | null
  readonly command: string | null
  /**
   * Server-supplied allowable answers; the UI offers these verbatim. Codex
   * decisions are opaque values (string or rule-carrying object) echoed back;
   * ACP decisions are `{ optionId, name, kind }` options rendered by `name` and
   * answered by `optionId` (see `codex-approval-view.ts`).
   */
  readonly availableDecisions: ReadonlyArray<unknown>
}

export interface TurnResult {
  /** `completed` | `interrupted` | `failed` | `unknown`. */
  readonly status: string
  /** The session's cumulative rows through this turn — ready for `IngestStore.replaceSession`. */
  readonly rows: ExtractedRows
}

/**
 * The launch params the {@link RpcSessionManager} hands whichever dialect factory
 * it picks — one shape so the factory reference is a clean union. `sandbox` /
 * `approvalPolicy` are codex thread config (ACP ignores them); `resumeThreadId`
 * rejoins an existing session by native id.
 */
export interface AppServerLaunchParams {
  readonly cwd: string
  readonly model?: string
  readonly sandbox?: "read-only" | "workspace-write" | "danger-full-access"
  readonly approvalPolicy?: "untrusted" | "on-failure" | "on-request" | "never"
  readonly env?: Record<string, string>
  readonly clientName?: string
  readonly resumeThreadId?: string
}

export interface AppServerDriver {
  /** The native session id — codex thread id / ACP session id. */
  readonly threadId: string
  /** Send a user turn and resolve once it completes, with the session's cumulative rows + status. */
  readonly runTurn: (text: string) => Effect.Effect<TurnResult, AppServerDriverError>
  /** The current outstanding approvals; subscribe via `.changes` for the live signal. */
  readonly pendingApprovals: SubscriptionRef.SubscriptionRef<ReadonlyArray<PendingApproval>>
  /** Answer an approval with a server-offered decision (the driver shapes the dialect envelope). */
  readonly answerApproval: (id: number | string, decision: unknown) => Effect.Effect<void, AppServerDriverError>
}
