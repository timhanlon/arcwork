import { useState } from "react"
import { SidebarSimple } from "@phosphor-icons/react"
import { IconButton } from "./IconButton.js"

export default {
  title: "Components / IconButton",
}

/** Resting vs. active (toggle-on) treatment, side by side. */
export const States = () => (
  <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
    <IconButton aria-label="resting">
      <SidebarSimple size={16} weight="regular" />
    </IconButton>
    <IconButton active aria-label="active">
      <SidebarSimple size={16} weight="regular" />
    </IconButton>
    <IconButton disabled aria-label="disabled">
      <SidebarSimple size={16} weight="regular" />
    </IconButton>
  </div>
)

/**
 * The App header in miniature: left toggle (sidebar) pinned left, right toggle
 * (terminal panel, mirrored glyph) pinned right. `active` mirrors panel-open.
 * Click each to confirm the on/off accent treatment reads clearly.
 */
export const PanelToggles = () => {
  const [leftOpen, setLeftOpen] = useState(true)
  const [rightOpen, setRightOpen] = useState(true)
  return (
    <div
      style={{ width: 520, border: "1px solid var(--border)", borderRadius: "var(--radius)" }}
    >
      <header
        style={{
          display: "flex",
          height: 32,
          alignItems: "center",
          justifyContent: "space-between",
          borderBottom: "1px solid var(--border)",
          padding: "0 6px",
        }}
      >
        <IconButton
          active={leftOpen}
          aria-label={`${leftOpen ? "Hide" : "Show"} sidebar`}
          onClick={() => setLeftOpen((v) => !v)}
        >
          <SidebarSimple size={16} weight="regular" />
        </IconButton>
        <IconButton
          active={rightOpen}
          aria-label={`${rightOpen ? "Hide" : "Show"} terminal panel`}
          onClick={() => setRightOpen((v) => !v)}
        >
          <SidebarSimple size={16} weight="regular" className="-scale-x-100" />
        </IconButton>
      </header>
      <div style={{ padding: 16, color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
        left: {leftOpen ? "open" : "collapsed"} · right: {rightOpen ? "open" : "collapsed"}
      </div>
    </div>
  )
}
