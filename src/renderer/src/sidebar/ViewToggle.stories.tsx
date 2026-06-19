import { useState } from "react"
import { ViewToggle, type ViewKey } from "./ViewToggle.js"

export default {
  title: "Sidebar / ViewToggle",
}

/** Live single-select: click a segment to switch; the active one is ignored. */
export const Interactive = () => {
  const [view, setView] = useState<ViewKey>("chat")
  return (
    <div style={{ width: 240 }}>
      <ViewToggle value={view} onValueChange={setView} />
      <p style={{ marginTop: 12, color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
        center view: {view}
      </p>
    </div>
  )
}

/** Both resting states side by side, to check the pressed accent treatment. */
export const States = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16, width: 240 }}>
    <ViewToggle value="chat" onValueChange={() => {}} />
    <ViewToggle value="work" onValueChange={() => {}} />
  </div>
)

/**
 * In its real home: the left-pane header — "arc" wordmark over the toggle,
 * matching the sidebar's 14px padding so spacing reads true.
 */
export const InSidebarHeader = () => {
  const [view, setView] = useState<ViewKey>("chat")
  return (
    <div
      style={{
        width: 260,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        padding: 14,
      }}
    >
      <div
        style={{
          marginBottom: 14,
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <span style={{ fontFamily: "var(--mono)", fontSize: 13, fontWeight: 500 }}>arc</span>
      </div>
      <ViewToggle value={view} onValueChange={setView} />
    </div>
  )
}
