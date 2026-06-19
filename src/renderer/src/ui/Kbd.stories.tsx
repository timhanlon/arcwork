import type { ReactNode } from "react"
import { Command, ArrowFatUp } from "@phosphor-icons/react"
import { Kbd, KbdGroup, KbdShortcut } from "./Kbd.js"

export default {
  title: "Components / Kbd",
}

const COMBOS: ReadonlyArray<{ readonly combo: string; readonly note: string }> = [
  { combo: "mod+b", note: "single modifier + letter" },
  { combo: "mod+shift+p", note: "the resume shortcut" },
  { combo: "mod+alt+b", note: "two modifiers, incl. ⌥ Option" },
  { combo: "mod+arrowdown", note: "arrow key as a glyph" },
  { combo: "end", note: "named key, no modifier" },
  { combo: "mod+1", note: "digit key" },
]

function Row({ children }: { readonly children: ReactNode }) {
  return (
    <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "6px 0" }}>
      {children}
    </div>
  )
}

/** Keybinding combos rendered as KbdGroups of per-key chips. */
export const Shortcuts = () => (
  <div style={{ padding: 16, width: 360, maxWidth: "100%" }}>
    {COMBOS.map(({ combo, note }) => (
      <Row key={combo}>
        <KbdShortcut combo={combo} />
        <span style={{ fontFamily: "var(--mono)", fontSize: 11, color: "var(--fg-faint)" }}>
          {note}
        </span>
      </Row>
    ))}
  </div>
)

/** The raw primitives: a single Kbd, glyph chips, and a hand-built group. */
export const Primitives = () => (
  <div style={{ padding: 16, display: "grid", gap: 12 }}>
    <Row>
      <Kbd>Esc</Kbd>
      <Kbd>⏎</Kbd>
      <Kbd>K</Kbd>
    </Row>
    <Row>
      <KbdGroup>
        <Kbd>
          <Command aria-hidden />
        </Kbd>
        <Kbd>
          <ArrowFatUp aria-hidden />
        </Kbd>
        <Kbd>P</Kbd>
      </KbdGroup>
    </Row>
  </div>
)

/** Inline in running prose, the way the resume caption uses it. */
export const InCaption = () => (
  <div style={{ padding: 16, color: "var(--fg-faint)", fontFamily: "var(--mono)", fontSize: 12 }}>
    <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
      resume claude session <KbdShortcut combo="mod+shift+p" />
    </span>
  </div>
)
