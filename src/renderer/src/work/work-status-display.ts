import type { WorkStatus } from "../../../shared/work.js"
import { WORK_STATUSES } from "../../../shared/work.js"
import { XSquareIcon,MinusSquareIcon, CheckSquareIcon } from "@phosphor-icons/react"
import type { Icon } from "@phosphor-icons/react"

/**
 * Shared presentation of authored work status — the dot colour, icon, and resolved
 * test every work surface (chat list, sidebar tree, navigator, arc MCP cards)
 * renders, so they never drift on what "blocked" or "done" looks like. The status
 * lifecycle order itself is the single list in `shared/work.ts`, re-exported here
 * so presentation consumers reach status through one import.
 */

export { WORK_STATUSES }

/** {@link WORK_STATUSES} shaped for the shared `Select` picker. */
export const STATUS_OPTIONS = WORK_STATUSES.map((value) => ({ value }))

/** Status → theme colour token, used for the status dot. */
export const STATUS_DOT: Record<WorkStatus, string> = {
  open: "var(--fg-dim)",
  active: "var(--accent)",
  blocked: "var(--request)",
  done: "var(--ok)",
  superseded: "var(--fg-faint)",
}

/** Status → icon, used for the status marker. */
export const STATUS_ICON: Partial<Record<WorkStatus, Icon>> = {
  blocked: XSquareIcon,
  done: CheckSquareIcon,
  superseded: MinusSquareIcon,
}

/** done/superseded are "resolved" — out of the open queue, marked with a check-square. */
export const isResolved = (status: WorkStatus): boolean =>
  status === "done" || status === "superseded"
