import type { JSX } from "react"
import type { WorkPriority } from "../../../shared/work.js"
import { Select } from "../ui/Select.js"
import { PRIORITY_COLOR, WORK_PRIORITIES } from "./work-priority-display.js"

/**
 * The two shared priority widgets the work surfaces render: a coloured read-only
 * chip (list rows, detail header) and a picker (detail, create form). Kept apart
 * from `WorkPane` so `ChatWork` reuses the chip without importing the navigator,
 * and so both story in isolation.
 */

/** A coloured, read-only badge for a set priority. p0 reads urgent, fading to p3. */
export function PriorityChip({ priority }: { readonly priority: WorkPriority }): JSX.Element {
  return (
    <span
      className="flex-none rounded-[var(--radius)] border px-1 font-mono text-[10px] uppercase tracking-[0.04em]"
      style={{ borderColor: PRIORITY_COLOR[priority], color: PRIORITY_COLOR[priority] }}
      title={`priority ${priority}`}
    >
      {priority}
    </span>
  )
}

const PRIORITY_OPTIONS = WORK_PRIORITIES.map((p) => ({ value: p }))

export interface PrioritySelectProps {
  /** The current priority, or null when unranked. */
  readonly value: WorkPriority | null
  readonly disabled?: boolean
  readonly onChange: (priority: WorkPriority) => void
  /** Override the select's class (e.g. to stretch full-width in a form column). */
  readonly className?: string
}

/**
 * A priority picker. There is deliberately no "clear" action — v0 has no verb to
 * un-rank work — so the empty option is only the *display* of an unranked item
 * (disabled, never a selectable target); choosing a level sets it.
 */
export function PrioritySelect(props: PrioritySelectProps): JSX.Element {
  const { value, disabled, onChange, className } = props
  return (
    <Select
      className={className}
      value={value}
      options={PRIORITY_OPTIONS}
      onValueChange={onChange}
      disabled={disabled}
      placeholder="— none"
      aria-label="priority"
    />
  )
}
