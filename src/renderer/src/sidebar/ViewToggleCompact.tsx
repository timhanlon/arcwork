import type { JSX } from "react"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import { Toggle } from "@base-ui/react/toggle"
import { Chat, Notebook } from "@phosphor-icons/react"
import type { ViewKey } from "./ViewToggle.js"
import { bindingFor } from "../shell/keybindings.js"
import { ICON_BUTTON_BASE, ICON_BUTTON_REST } from "../ui/IconButton.js"

export interface ViewToggleCompactProps {
  readonly value: ViewKey
  readonly onValueChange: (value: ViewKey) => void
  readonly className?: string
}

const ITEMS = [
  { value: "chat", label: "chats", Icon: Chat, command: "showChatView" },
  { value: "work", label: "work", Icon: Notebook, command: "showWorkView" },
] as const

// Borderless segments that read like the nav bar's IconButtons: no surrounding
// box or padding, accent text marks the active view. Built from IconButton's own
// class constants so the two stay in lockstep; the base-ui Toggle drives the
// accent via data-[pressed] in place of IconButton's `active` prop.
const ITEM = `${ICON_BUTTON_BASE} ${ICON_BUTTON_REST} data-[pressed]:text-accent`

/**
 * The compact, chrome-free twin of {@link ViewToggle} for the top nav bar. Same
 * single-select chats / work behaviour, but it drops the bordered container so
 * the two segments sit flush among the nav's icon buttons instead of reading as
 * a boxed control. Clicking the active segment is ignored, so the group can
 * never empty out.
 */
export function ViewToggleCompact({
  value,
  onValueChange,
  className,
}: ViewToggleCompactProps): JSX.Element {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const picked = next.find((v) => v !== value) ?? next[0]
        if (picked && picked !== value) onValueChange(picked as ViewKey)
      }}
      aria-label="Center view"
      className={["inline-flex items-center gap-0.5", className].filter(Boolean).join(" ")}
    >
      {ITEMS.map(({ value: v, label, Icon, command }) => {
        const accel = bindingFor(command)?.label
        return (
          <Toggle
            key={v}
            value={v}
            aria-label={label}
            title={accel ? `${label} (${accel})` : label}
            className={ITEM}
          >
            <Icon size={16} weight="regular" />
          </Toggle>
        )
      })}
    </ToggleGroup>
  )
}
