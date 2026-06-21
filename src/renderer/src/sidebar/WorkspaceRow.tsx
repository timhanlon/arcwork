import type { JSX, ReactNode } from "react"
import { Button } from "@base-ui/react/button"
import { GitBranch } from "@phosphor-icons/react"
import type { Workspace } from "../../../shared/workspace.js"
import { ROW_ACTIVE, ROW_BASE, ROW_GRID, TREE_LABEL, TREE_MAIN, TREE_SUBTITLE } from "./row-styles.js"

export interface WorkspaceRowProps {
  readonly workspace: Workspace
  readonly selected: boolean
  readonly onSelect: () => void
  /**
   * The 18px disclosure-column slot. The tree fills it with the live
   * `Collapsible.Trigger`; stories pass a static chevron so the row reads
   * complete in isolation.
   */
  readonly disclosure: ReactNode
}

/** Top-level workspace row: disclosure gutter + name over its filesystem path. */
export function WorkspaceRow({ workspace, selected, onSelect, disclosure }: WorkspaceRowProps): JSX.Element {
  return (
    <div className={ROW_GRID} role="treeitem" aria-expanded="true">
      {disclosure}
      <Button
        className={`${ROW_BASE} justify-between gap-2 ${selected ? ROW_ACTIVE : ""}`}
        onClick={onSelect}
      >
        <span className={TREE_MAIN}>
          <span className="flex min-w-0 items-center gap-1.5">
            <span className={TREE_LABEL}>{workspace.name}</span>
            {workspace.branch ? (
              <span
                className="flex flex-none items-center gap-1 rounded-[var(--radius)] bg-elev px-1 font-mono text-[10px] text-fg-dim"
                title={workspace.isWorktree ? `worktree on ${workspace.branch}` : `branch ${workspace.branch}`}
              >
                <GitBranch size={9} aria-hidden />
                {workspace.branch}
              </span>
            ) : null}
          </span>
          <span className={TREE_SUBTITLE}>{workspace.path}</span>
        </span>
      </Button>
    </div>
  )
}
