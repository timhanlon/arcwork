import type { AppServerApproval, AppServerApprovalDecision } from "../../shared/codex-approval.js"
import { obj, str } from "../ingest/extract/json.js"
import type { SessionApprovals } from "./CodexDriverRegistry.js"

/**
 * Normalize one raw server decision into a renderer button, spanning both
 * dialects' answer models:
 *   - **ACP** — a `{ optionId, name, kind }` option: label by `name`, and encode
 *     `payload` as just the `optionId` string, so answering sends that id back
 *     (the ACP driver wraps it as `{ outcome: { outcome: "selected", optionId } }`).
 *   - **codex** — an opaque decision: a string (`"accept"`) labels itself; a
 *     rule-carrying object (`{ acceptWithExecpolicyAmendment: {…} }`) labels by
 *     its key. `payload` is the whole decision JSON, echoed back verbatim.
 */
const decisionView = (decision: unknown): AppServerApprovalDecision => {
  const record = obj(decision)
  const optionId = str(record?.["optionId"])
  if (optionId) {
    return { label: str(record?.["name"]) ?? optionId, payload: JSON.stringify(optionId) }
  }
  const label = typeof decision === "string" ? decision : (Object.keys(record ?? {})[0] ?? "decision")
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
