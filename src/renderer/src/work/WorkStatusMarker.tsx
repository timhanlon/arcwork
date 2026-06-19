import type { JSX } from "react"
import { CheckSquareIcon } from "@phosphor-icons/react"
import type { WorkStatus } from "../../../shared/work.js"
import { STATUS_ICON } from "./work-status-display.js"

/**
 * The leading completion indicator shared by every work surface: a check-square
 * for resolved (done/superseded) work, and nothing for in-flight work. The old
 * status dot carried colour but mostly read as noise next to the title, so it's
 * gone — completion is the one distinction worth a glyph. Centralised so the
 * chat list, sidebar tree, navigator, and arc MCP cards never drift.
 *
 * In a vertical list pass `placeholder` (the default) so unresolved rows reserve
 * the check column and titles stay aligned — a checkbox metaphor. Inline uses
 * (a status badge) pass `placeholder={false}` to render nothing when unresolved.
 */
export function WorkStatusMarker({
  status,
  title,
  placeholder = true,
}: {
  readonly status: WorkStatus
  readonly title?: string
  readonly placeholder?: boolean
}): JSX.Element | null {
  const Icon = STATUS_ICON[status]
  if (Icon) {
    return (
      <span className="flex-none" title={title}>
        <Icon size={14} aria-hidden />
      </span>
    )
  }
  return placeholder ? <span className="size-3.5 flex-none" aria-hidden /> : null
}
