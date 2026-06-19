import { Menu } from "@base-ui/react/menu"
import { Check, Funnel } from "@phosphor-icons/react"
import type { JSX } from "react"
import type { ChatMessage } from "../../../shared/chat-message.js"
import { classifyTool } from "../../../shared/tool-catalog.js"

/**
 * How much of the transcript to show, as a three-step "most → least noise" dial:
 *   - `all`      — every row (prose + every tool call + question)
 *   - `diffs`    — prose + file-change tool calls only
 *   - `messages` — prose only (the conversation)
 */
export type TranscriptFilter = "all" | "diffs" | "messages"

const OPTIONS: ReadonlyArray<{ readonly value: TranscriptFilter; readonly label: string }> = [
  { value: "all", label: "everything" },
  { value: "diffs", label: "file changes" },
  { value: "messages", label: "messages" },
]

const labelFor = (filter: TranscriptFilter): string =>
  OPTIONS.find((option) => option.value === filter)?.label ?? "everything"

/**
 * Whether a transcript row survives the current filter. Prose turns always show;
 * the filter only governs the payload-bearing rows. `diffs` keeps only the
 * file-change tool calls — anything the catalog classifies as a `write` (Edit /
 * Write / MultiEdit / apply_patch / StrReplace / Delete), so writes that render
 * as raw JSON still count.
 */
export const showsMessage = (message: ChatMessage, filter: TranscriptFilter): boolean => {
  const payload = message.payload
  if (payload === undefined) return true
  if (filter === "all") return true
  if (filter === "messages") return false
  return payload.kind === "tool" && classifyTool(message.provider, payload.toolName) === "write"
}

const TRIGGER =
  "inline-flex items-center gap-1 font-mono text-[10px] lowercase tracking-[0.06em] text-fg-dim cursor-pointer outline-none hover:text-foreground focus-visible:text-foreground"
const POPUP =
  "min-w-[140px] origin-[var(--transform-origin)] rounded-[var(--radius)] border border-border-strong bg-elev p-1 font-mono text-[11px] shadow-lg outline-none"
const ITEM =
  "flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius)] px-2 py-1 text-fg-dim outline-none data-[highlighted]:bg-input data-[highlighted]:text-foreground"

/**
 * Compact "show: …" header control that picks the {@link TranscriptFilter}. A
 * base-ui radio menu so the active level carries a checkmark; the trigger reads
 * out the current label so the filter's state is legible without opening it.
 */
export function TranscriptFilterMenu({
  value,
  onChange,
}: {
  readonly value: TranscriptFilter
  readonly onChange: (value: TranscriptFilter) => void
}): JSX.Element {
  return (
    <Menu.Root>
      <Menu.Trigger className={TRIGGER} aria-label={`Transcript filter: ${labelFor(value)}`}>
        <Funnel size={14} weight={value === "all" ? "regular" : "fill"} />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner className="z-50" side="bottom" align="end" sideOffset={4}>
          <Menu.Popup className={POPUP}>
            <Menu.RadioGroup value={value} onValueChange={(next) => onChange(next as TranscriptFilter)}>
              {OPTIONS.map((option) => (
                <Menu.RadioItem key={option.value} value={option.value} className={ITEM}>
                  {/* Fixed-width slot so the label column stays aligned whether or
                      not this row is the checked one (the indicator only mounts
                      when selected). */}
                  <span className="flex w-3 flex-none justify-center">
                    <Menu.RadioItemIndicator>
                      <Check size={11} weight="bold" />
                    </Menu.RadioItemIndicator>
                  </span>
                  {option.label}
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  )
}
