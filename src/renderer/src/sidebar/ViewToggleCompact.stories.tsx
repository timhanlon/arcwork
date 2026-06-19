import { useState } from "react"
import { SidebarSimple } from "@phosphor-icons/react"
import { ViewToggleCompact } from "./ViewToggleCompact.js"
import type { ViewKey } from "./ViewToggle.js"
import { IconButton } from "../ui/IconButton.js"

export default {
  title: "Sidebar / ViewToggleCompact",
}

/** Live single-select: click a segment to switch; the active one is ignored. */
export const Interactive = () => {
  const [view, setView] = useState<ViewKey>("chat")
  return (
    <div style={{ width: 240 }}>
      <ViewToggleCompact value={view} onValueChange={setView} />
      <p style={{ marginTop: 12, color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
        center view: {view}
      </p>
    </div>
  )
}

/** Both resting states side by side, to check the active accent treatment. */
export const States = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 16 }}>
    <ViewToggleCompact value="chat" onValueChange={() => {}} />
    <ViewToggleCompact value="work" onValueChange={() => {}} />
  </div>
)

/**
 * In its real home: a stand-in for the top nav bar (h-8, bordered, padded like
 * NavBar) with the compact toggle sitting flush beside an icon button, so the
 * borderless segments read true against the rest of the nav chrome.
 */
export const InNavBar = () => {
  const [view, setView] = useState<ViewKey>("chat")
  return (
    <header className="flex h-8 w-[280px] flex-none items-center justify-between border-b border-border px-1.5">
      <div className="flex items-center gap-0.5">
        <IconButton aria-label="Toggle sidebar" title="Toggle sidebar">
          <SidebarSimple size={16} weight="regular" />
        </IconButton>
        <ViewToggleCompact value={view} onValueChange={setView} />
      </div>
    </header>
  )
}
