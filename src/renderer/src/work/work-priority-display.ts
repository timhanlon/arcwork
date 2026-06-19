import type { WorkPriority } from "../../../shared/work.js"

/**
 * Shared presentation of authored work priority — the chip colour and the
 * ordering both the chat-scoped list (`ChatWork`) and the global navigator
 * (`WorkPane`) render, so the two surfaces never drift. Priority is the one
 * ranking signal labels can't express; unset is a real state (no chip), distinct
 * from `p3`.
 */

/** Every priority, highest first — the order a picker offers and the queue sorts. */
export const WORK_PRIORITIES: ReadonlyArray<WorkPriority> = ["p0", "p1", "p2", "p3"]

/** Priority → theme colour token for its chip. p0 reads as urgent and fades to p3. */
export const PRIORITY_COLOR: Record<WorkPriority, string> = {
  p0: "var(--danger)",
  p1: "var(--request)",
  p2: "var(--accent)",
  p3: "var(--fg-dim)",
}
