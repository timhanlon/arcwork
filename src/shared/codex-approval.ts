import { Schema } from "effect"

/**
 * The renderer-facing view of a codex app-server approval — the answer surface a
 * PTY session never needed. Unlike hook permissions (a coarse sidebar flag),
 * app-server approvals must be *answered inside Arc*, so this carries the detail
 * the inline card needs. Ephemeral: never persisted, mirrored live from the
 * driver's in-memory state (see CodexDriverRegistry).
 */

/**
 * One allowable answer, server-owned. `payload` is the raw decision re-encoded as
 * JSON so it survives the round-trip verbatim — the decision model is not
 * collapsed to approve/deny (`acceptWithExecpolicyAmendment` carries a rule
 * payload, etc.); the renderer echoes `payload` back unchanged.
 */
export const AppServerApprovalDecision = Schema.Struct({
  /** Display label for the button (a string decision's text, or an object decision's key). */
  label: Schema.String,
  /** JSON of the raw server decision, sent back to `AnswerAppServerApproval` unchanged. */
  payload: Schema.String,
})
export type AppServerApprovalDecision = typeof AppServerApprovalDecision.Type

export const AppServerApproval = Schema.Struct({
  chatId: Schema.String,
  targetSessionId: Schema.String,
  /** JSON-RPC request id — the routing key echoed back to answer this approval. */
  requestId: Schema.Union([Schema.String, Schema.Number]),
  /** Codex's approval handle when present (commandExecution only); display detail. */
  approvalId: Schema.NullOr(Schema.String),
  /** The tool-call item this approval gates. */
  itemId: Schema.NullOr(Schema.String),
  command: Schema.NullOr(Schema.String),
  decisions: Schema.Array(AppServerApprovalDecision),
})
export type AppServerApproval = typeof AppServerApproval.Type
