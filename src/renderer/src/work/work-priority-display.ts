import type { WorkPriority } from "../../../shared/work.js"
import { WORK_PRIORITIES } from "../../../shared/work.js"

/**
 * Shared presentation of authored work priority — the chip colour and ordering
 * every work surface renders, so they never drift on what a priority looks like.
 * Priority is the one ranking signal labels can't express; unset is a real state
 * (no chip), distinct from `p3`. The priority list itself is the single array in
 * `shared/work.ts`, re-exported here so presentation consumers have one import.
 */

export { WORK_PRIORITIES }

/** Priority → theme colour token for its chip. p0 reads as urgent and fades to p3. */
export const PRIORITY_COLOR: Record<WorkPriority, string> = {
  p0: "var(--danger)",
  p1: "var(--request)",
  p2: "var(--accent)",
  p3: "var(--fg-dim)",
}
