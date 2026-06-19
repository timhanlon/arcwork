import type { Icon } from "@phosphor-icons/react"
import type { JSX } from "react"
import {
  Command,
  Control,
  NumberOne,
  NumberTwo,
  NumberThree,
  NumberFour,
  NumberFive,
  NumberSix,
  NumberSeven,
  NumberEight,
  NumberNine,
} from "@phosphor-icons/react"
import { bindingFor, focusRequestId, isMac, type RequestSlot } from "../shell/keybindings.js"

// Indexed by slot − 1, so NUMBER_ICONS[0] is the "1" glyph.
const NUMBER_ICONS: ReadonlyArray<Icon> = [
  NumberOne,
  NumberTwo,
  NumberThree,
  NumberFour,
  NumberFive,
  NumberSix,
  NumberSeven,
  NumberEight,
  NumberNine,
]

export interface KeyHintProps {
  /** The modifier + number slot this hint represents (1-based, 1–9). */
  readonly slot: number
}

/**
 * A compact "⌘N" chip built from Phosphor glyphs — the modifier (Command on
 * macOS, Control elsewhere) and the digit (NumberOne…NumberNine) — rather than
 * font characters, so it stays crisp at small sizes. Marks which key jumps to a
 * waiting session row.
 *
 * The digit is read from the registry's `focusRequest${slot}` binding rather than
 * assumed to equal `slot`, so a rebind is reflected here. Renders nothing when no
 * binding exists or it isn't the expected modifier-plus-digit shape.
 */
export function KeyHint({ slot }: KeyHintProps): JSX.Element | null {
  const combo = bindingFor(focusRequestId(slot as RequestSlot))?.combo
  const digit = combo ? Number.parseInt(combo.slice(combo.lastIndexOf("+") + 1), 10) : NaN
  const DigitGlyph = NUMBER_ICONS[digit - 1]
  if (!DigitGlyph) return null
  const Mod = isMac ? Command : Control
  return (
    <kbd
      className="inline-flex flex-none items-center gap-px rounded-[3px] border border-request-border bg-request-fill px-1 py-px text-request"
      aria-label={`${isMac ? "Command" : "Control"} ${digit}`}
    >
      <Mod size={11} weight="bold" aria-hidden />
      <DigitGlyph size={11} weight="bold" aria-hidden />
    </kbd>
  )
}
