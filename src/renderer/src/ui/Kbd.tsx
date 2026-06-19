import type { Icon } from "@phosphor-icons/react"
import { ArrowDown, ArrowFatUp, ArrowUp, Command, Control, Option } from "@phosphor-icons/react"
import type { ComponentProps, JSX } from "react"
import { isMac } from "../shell/keybindings.js"

const join = (...parts: ReadonlyArray<string | undefined>): string =>
  parts.filter(Boolean).join(" ")

// Ported from basecn's Kbd (https://basecn.dev/docs/components/kbd), mapped onto
// this app's tokens (--elev / --fg-dim / --border / --radius instead of shadcn's
// muted pair). Each key is its own uniform chip — `h-5 min-w-5`, contents
// centred — so glyphs and letters line up by construction rather than by fiddling
// with per-glyph size/weight. Child SVGs auto-size to `size-3` unless they carry
// their own size class.
const KBD =
  "pointer-events-none inline-flex h-5 w-fit min-w-5 select-none items-center justify-center gap-1 rounded-[var(--radius)] border border-border bg-elev px-1 font-sans text-[11px] font-medium leading-none text-fg-dim [&_svg:not([class*='size-'])]:size-3"

export function Kbd({ className, ...props }: ComponentProps<"kbd">): JSX.Element {
  return <kbd data-slot="kbd" className={join(KBD, className)} {...props} />
}

export function KbdGroup({ className, ...props }: ComponentProps<"div">): JSX.Element {
  return (
    <div data-slot="kbd-group" className={join("inline-flex items-center gap-1", className)} {...props} />
  )
}

// --- combo → chips ----------------------------------------------------------
// A keybinding `combo` (e.g. "mod+shift+p", see keybindings.ts) rendered as a
// KbdGroup with one chip per token. Modifiers become Phosphor glyphs on macOS
// (where chords are symbol-only) and spelled-out text elsewhere.

const modIcon = (token: string): Icon | undefined => {
  if (!isMac) return undefined
  switch (token) {
    case "mod":
      return Command
    case "ctrl":
      return Control
    case "alt":
      return Option
    case "shift":
      return ArrowFatUp
    default:
      return undefined
  }
}

const modText = (token: string): string => {
  switch (token) {
    case "mod":
    case "ctrl":
      return "Ctrl"
    case "alt":
      return "Alt"
    case "shift":
      return "Shift"
    default:
      return token
  }
}

const KEY_ICON: Record<string, Icon> = { arrowdown: ArrowDown, arrowup: ArrowUp }
const keyText = (token: string): string => {
  switch (token) {
    case "end":
      return "End"
    case "escape":
      return "Esc"
    case "enter":
      return "⏎"
    default:
      return token.toUpperCase()
  }
}

const READABLE: Record<string, string> = {
  mod: isMac ? "Command" : "Control",
  ctrl: "Control",
  alt: isMac ? "Option" : "Alt",
  shift: "Shift",
  arrowdown: "Arrow Down",
  arrowup: "Arrow Up",
  end: "End",
  escape: "Escape",
  enter: "Return",
}
const readable = (token: string): string => READABLE[token] ?? token.toUpperCase()

export interface KbdShortcutProps {
  /** A keybinding combo, e.g. `"mod+shift+p"`. */
  readonly combo: string
  readonly className?: string
}

export function KbdShortcut({ combo, className }: KbdShortcutProps): JSX.Element {
  const tokens = combo.split("+")
  const key = tokens[tokens.length - 1] ?? ""
  const mods = tokens.slice(0, -1)
  const KeyGlyph = KEY_ICON[key]
  return (
    <KbdGroup className={className} aria-label={tokens.map(readable).join(" ")}>
      {mods.map((token) => {
        const Glyph = modIcon(token)
        return <Kbd key={token}>{Glyph ? <Glyph aria-hidden /> : modText(token)}</Kbd>
      })}
      <Kbd>{KeyGlyph ? <KeyGlyph aria-hidden /> : keyText(key)}</Kbd>
    </KbdGroup>
  )
}
