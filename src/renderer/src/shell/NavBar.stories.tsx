import { useState } from "react"
import { NavBar } from "./NavBar.js"
import type { ViewKey } from "../sidebar/ViewToggleCompact.js"

export default {
  title: "Shell / NavBar",
}

/** Both panels open — the resting state with both toggles active. */
export const BothOpen = () => (
  <NavBar
    isDev={false}
    centerView="chat"
    rightView="terminal"
    leftPanelCollapsed={false}
    rightPanelCollapsed={false}
    onCenterViewChange={() => {}}
    onRightViewChange={() => {}}
    onToggleLeftPanel={() => {}}
    onToggleRightPanel={() => {}}
    onOpenWorkspace={() => {}}
  />
)

/** Both panels collapsed — both toggles read as off. */
export const BothCollapsed = () => (
  <NavBar
    isDev={false}
    centerView="chat"
    rightView="git"
    leftPanelCollapsed
    rightPanelCollapsed
    onCenterViewChange={() => {}}
    onRightViewChange={() => {}}
    onToggleLeftPanel={() => {}}
    onToggleRightPanel={() => {}}
    onOpenWorkspace={() => {}}
  />
)

/** Dev profile — the badge sits to the left of the sidebar toggle. */
export const DevProfile = () => (
  <NavBar
    isDev
    centerView="chat"
    rightView="terminal"
    leftPanelCollapsed={false}
    rightPanelCollapsed={false}
    onCenterViewChange={() => {}}
    onRightViewChange={() => {}}
    onToggleLeftPanel={() => {}}
    onToggleRightPanel={() => {}}
    onOpenWorkspace={() => {}}
  />
)

/** Live toggles, driven by local state — click each control to flip its state. */
export const Interactive = () => {
  const [left, setLeft] = useState(false)
  const [right, setRight] = useState(false)
  const [view, setView] = useState<ViewKey>("chat")
  const [rightView, setRightView] = useState<"terminal" | "git">("terminal")
  return (
    <NavBar
      isDev={false}
      centerView={view}
      rightView={rightView}
      leftPanelCollapsed={left}
      rightPanelCollapsed={right}
      onCenterViewChange={setView}
      onRightViewChange={setRightView}
      onToggleLeftPanel={() => setLeft((v) => !v)}
      onToggleRightPanel={() => setRight((v) => !v)}
      onOpenWorkspace={() => {}}
    />
  )
}
