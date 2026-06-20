import type { JSX } from "react"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import { Toggle } from "@base-ui/react/toggle"
import { Chat, Notebook } from "@phosphor-icons/react"
import { ICON_TOGGLE_ITEM } from "../ui/IconButton.js"

/** Which surface the center pane shows. Mirrors the shell machine's `centerView`. */
export type ViewKey = "chat" | "work"

export interface ViewToggleProps {
  readonly value: ViewKey
  readonly onValueChange: (value: ViewKey) => void
  readonly className?: string
}

const ITEMS = [
  { value: "chat", label: "chats", Icon: Chat },
  { value: "work", label: "work", Icon: Notebook },
] as const

// The boxed twin of {@link ViewToggleCompact}: the shared toggle recipe plus a
// filled pressed segment (the bordered container makes accent-text alone too
// quiet to read as "selected").
const ITEM = `${ICON_TOGGLE_ITEM} data-[pressed]:bg-elev data-[pressed]:shadow-[inset_0_0_0_1px_var(--border)]`

/**
 * The left pane's chats / work switcher — a single-select, icon-only segmented
 * control built on base-ui's ToggleGroup. Replaces the standalone "work" nav
 * button: one always-selected segment drives the center view (see the shell
 * machine's `centerView`). Clicking the already-active segment is ignored, so
 * the group can never land in an empty state.
 */
export function ViewToggle({ value, onValueChange, className }: ViewToggleProps): JSX.Element {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const picked = next.find((v) => v !== value) ?? next[0]
        if (picked && picked !== value) onValueChange(picked as ViewKey)
      }}
      aria-label="Center view"
      className={["inline-flex gap-0.5 rounded-[var(--radius)] border border-border p-0.5", className]
        .filter(Boolean)
        .join(" ")}
    >
      {ITEMS.map(({ value: v, label, Icon }) => (
        <Toggle key={v} value={v} aria-label={label} title={label} className={ITEM}>
          <Icon size={16} weight="regular" />
        </Toggle>
      ))}
    </ToggleGroup>
  )
}
