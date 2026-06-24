import type { JSX } from "react"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import { Toggle } from "@base-ui/react/toggle"
import { FolderSimplePlus, GitMerge, SidebarSimple, Terminal } from "@phosphor-icons/react"
import { IconButton, ICON_TOGGLE_ITEM } from "../ui/IconButton.js"
import { ViewToggleCompact } from "../sidebar/ViewToggleCompact.js"
import type { ViewKey } from "../sidebar/ViewToggleCompact.js"
import { bindingFor } from "./keybindings.js"

export interface NavBarProps {
  /** running under the `dev` profile — surfaces a badge since macOS labels the binary "Electron" */
  readonly isDev: boolean
  readonly centerView: ViewKey
  readonly rightView: "terminal" | "git"
  readonly leftPanelCollapsed: boolean
  readonly rightPanelCollapsed: boolean
  readonly onCenterViewChange: (view: ViewKey) => void
  readonly onRightViewChange: (view: "terminal" | "git") => void
  readonly onToggleLeftPanel: () => void
  readonly onToggleRightPanel: () => void
  readonly onOpenWorkspace: () => void
}

/**
 * The app's top chrome bar. A three-column grid: the sidebar toggle and
 * open-workspace action on the left, the chats / work view toggle dead-centered
 * regardless of flank widths, and the terminal-panel toggle (mirrored glyph) on
 * the right. Extracted from App so
 * the bar can grow its own affordances without bloating the shell. Keybinding
 * labels are resolved here so callers pass only panel state + intent.
 */
export function NavBar({
  isDev,
  centerView,
  rightView,
  leftPanelCollapsed,
  rightPanelCollapsed,
  onCenterViewChange,
  onRightViewChange,
  onToggleLeftPanel,
  onToggleRightPanel,
  onOpenWorkspace,
}: NavBarProps): JSX.Element {
  const leftBinding = bindingFor("toggleLeftPanel")
  const rightBinding = bindingFor("toggleRightPanel")
  return (
    <header className="grid h-8 flex-none grid-cols-3 items-center border-b border-border px-1.5">
      <div className="flex items-center justify-self-start gap-0.5">
        {isDev && (
          <span className="mr-1 rounded-[var(--radius)] bg-accent/15 px-1.5 py-0.5 font-mono text-[10px] uppercase tracking-[0.06em] text-accent">
            dev
          </span>
        )}
        <IconButton
          active={!leftPanelCollapsed}
          aria-pressed={!leftPanelCollapsed}
          aria-label={`${leftPanelCollapsed ? "Show" : "Hide"} sidebar`}
          title={`${leftPanelCollapsed ? "Show" : "Hide"} sidebar${leftBinding ? ` (${leftBinding.label})` : ""}`}
          onClick={onToggleLeftPanel}
        >
          <SidebarSimple size={16} weight="regular" />
        </IconButton>
        <IconButton aria-label="Open workspace" title="Open workspace" onClick={onOpenWorkspace}>
          <FolderSimplePlus size={16} weight="regular" />
        </IconButton>
      </div>
      <div className="flex items-center justify-self-center">
        <ViewToggleCompact value={centerView} onValueChange={onCenterViewChange} />
      </div>
      <div className="flex items-center justify-self-end gap-0.5">
        <RightPaneToggle value={rightView} onValueChange={onRightViewChange} />
        <IconButton
          active={!rightPanelCollapsed}
          aria-pressed={!rightPanelCollapsed}
          aria-label={`${rightPanelCollapsed ? "Show" : "Hide"} terminal panel`}
          title={`${rightPanelCollapsed ? "Show" : "Hide"} terminal panel${rightBinding ? ` (${rightBinding.label})` : ""}`}
          onClick={onToggleRightPanel}
        >
          <SidebarSimple size={16} weight="regular" className="-scale-x-100" />
        </IconButton>
      </div>
    </header>
  )
}

const RIGHT_ITEMS = [
  { value: "terminal", label: "terminal", Icon: Terminal },
  { value: "git", label: "git", Icon: GitMerge },
] as const

function RightPaneToggle({
  value,
  onValueChange,
}: {
  readonly value: "terminal" | "git"
  readonly onValueChange: (value: "terminal" | "git") => void
}): JSX.Element {
  return (
    <ToggleGroup
      value={[value]}
      onValueChange={(next) => {
        const picked = next.find((v) => v !== value) ?? next[0]
        if (picked && picked !== value) onValueChange(picked as "terminal" | "git")
      }}
      aria-label="Right pane"
      className="inline-flex items-center gap-0.5"
    >
      {RIGHT_ITEMS.map(({ value: v, label, Icon }) => (
        <Toggle key={v} value={v} aria-label={label} title={label} className={ICON_TOGGLE_ITEM}>
          <Icon size={16} weight="regular" />
        </Toggle>
      ))}
    </ToggleGroup>
  )
}
