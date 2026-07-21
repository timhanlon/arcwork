import { useState } from "react"
import { NavBar } from "./NavBar.js"
import type { CenterTab } from "./arcShellMachine.js"
import { arcId } from "../../../shared/ids.js"

const CHAT_TAB: ReadonlyArray<CenterTab> = [{ id: "chat", kind: "chat" }]

export default {
  title: "Shell / NavBar",
}

/** Both panels open — the resting state with both toggles active. */
export const BothOpen = () => (
  <NavBar
    isDev={false}
    centerTabs={CHAT_TAB}
    activeCenterTabId="chat"
    rightView="terminal"
    leftPanelCollapsed={false}
    rightPanelCollapsed={false}
    onCenterTabSelect={() => {}}
    onCenterTabClose={() => {}}
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
    centerTabs={CHAT_TAB}
    activeCenterTabId="chat"
    rightView="git"
    leftPanelCollapsed
    rightPanelCollapsed
    onCenterTabSelect={() => {}}
    onCenterTabClose={() => {}}
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
    centerTabs={CHAT_TAB}
    activeCenterTabId="chat"
    rightView="terminal"
    leftPanelCollapsed={false}
    rightPanelCollapsed={false}
    onCenterTabSelect={() => {}}
    onCenterTabClose={() => {}}
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
  const [tabs, setTabs] = useState<ReadonlyArray<CenterTab>>([
    { id: "chat", kind: "chat" },
    { id: "work", kind: "work" },
    { id: "file:demo", kind: "file", workspaceId: arcId("workspace", "demo"), path: "src/App.tsx" },
  ])
  const [activeTabId, setActiveTabId] = useState("chat")
  const [rightView, setRightView] = useState<"terminal" | "files" | "git">("terminal")
  return (
    <NavBar
      isDev={false}
      centerTabs={tabs}
      activeCenterTabId={activeTabId}
      rightView={rightView}
      leftPanelCollapsed={left}
      rightPanelCollapsed={right}
      onCenterTabSelect={(tab) => setActiveTabId(tab.id)}
      onCenterTabClose={(id) => setTabs((current) => current.filter((tab) => tab.id !== id))}
      onRightViewChange={setRightView}
      onToggleLeftPanel={() => setLeft((v) => !v)}
      onToggleRightPanel={() => setRight((v) => !v)}
      onOpenWorkspace={() => {}}
    />
  )
}
