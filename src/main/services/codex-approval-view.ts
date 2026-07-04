import type { AppServerApproval, AppServerApprovalDecision } from "../../shared/codex-approval.js"
import { obj } from "../ingest/extract/json.js"
import type { SessionApprovals } from "./CodexDriverRegistry.js"

/**
 * Normalize one raw server decision into a renderer button. A string decision
 * (`"accept"`) labels itself; an object decision
 * (`{ acceptWithExecpolicyAmendment: {…} }`) labels by its key. `payload` is the
 * decision re-encoded as JSON so it round-trips to the driver unchanged.
 */
const decisionView = (decision: unknown): AppServerApprovalDecision => {
  const label =
    typeof decision === "string" ? decision : (Object.keys(obj(decision) ?? {})[0] ?? "decision")
  return { label, payload: JSON.stringify(decision) }
}

/** Flatten the registry's per-session aggregate into the renderer-facing list. */
export const projectApprovals = (
  sessions: ReadonlyArray<SessionApprovals>,
): ReadonlyArray<AppServerApproval> =>
  sessions.flatMap((session) =>
    session.approvals.map((approval) => ({
      chatId: session.chatId,
      targetSessionId: session.targetSessionId,
      requestId: approval.id,
      approvalId: approval.approvalId,
      itemId: approval.itemId,
      command: approval.command,
      decisions: approval.availableDecisions.map(decisionView),
    })),
  )

/**
 * Decode a decision `payload` back to the raw value to answer the driver.
 * Payloads originate from {@link decisionView}'s `JSON.stringify`, so parsing
 * succeeds; a malformed one falls back to the literal string rather than throwing.
 */
export const parseDecisionPayload = (payload: string): unknown => {
  try {
    return JSON.parse(payload)
  } catch {
    return payload
  }
}
