import type { JSX, ReactNode } from "react"
import { Button } from "@base-ui/react/button"
import { GitBranch } from "@phosphor-icons/react"
import type { Workspace, WorkspacePullRequest } from "../../../shared/workspace.js"
import { PrStateIcon, prStateColor, toPrState } from "../git/PrStateIcon.js"
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

/** Top-level workspace row: disclosure gutter + name over its filesystem path,
 * with a PR chip on the right when the branch has an open pull request. The chip
 * is a sibling of the select button (not nested) so its link stays valid markup
 * and clicking it opens the PR without selecting the row. */
export function WorkspaceRow({ workspace, selected, onSelect, disclosure }: WorkspaceRowProps): JSX.Element {
  return (
    <div className={ROW_GRID} role="treeitem" aria-expanded="true">
      {disclosure}
      <div className="flex min-w-0 items-center gap-1">
        <Button
          className={`${ROW_BASE} min-w-0 flex-1 justify-between gap-2 ${selected ? ROW_ACTIVE : ""}`}
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
        {workspace.pullRequest ? <PullRequestChip pr={workspace.pullRequest} /> : null}
      </div>
    </div>
  )
}

/** A compact link to the branch's open PR: state-coloured octicon + `#number`.
 * Opens the PR (routed to the system browser by the main window-open handler). */
function PullRequestChip({ pr }: { readonly pr: WorkspacePullRequest }): JSX.Element {
  const state = toPrState(pr.state)
  const tone = state ? prStateColor(state, pr.isDraft) : "text-fg-dim"
  const label = `#${pr.number} ${pr.title}`
  const inner = (
    <span className={`flex flex-none items-center gap-1 font-mono text-[10px] font-semibold ${tone}`}>
      {state ? <PrStateIcon state={state} isDraft={pr.isDraft} size={11} /> : null}#{pr.number}
    </span>
  )
  return pr.url ? (
    <a
      href={pr.url}
      target="_blank"
      rel="noreferrer"
      title={label}
      aria-label={`Open pull request ${label}`}
      className="flex flex-none items-center rounded-[var(--radius)] px-1 py-0.5 no-underline hover:bg-elev"
      onClick={(e) => e.stopPropagation()}
    >
      {inner}
    </a>
  ) : (
    <span title={label} className="px-1 py-0.5">
      {inner}
    </span>
  )
}
