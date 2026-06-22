import type { JSX } from "react"
import { CheckIcon, DotFillIcon, XIcon, type Icon } from "@primer/octicons-react"
import type { PullRequest, WorkspaceGitContext } from "../../../shared/git.js"
import { PrStateIcon, prStateColor } from "./PrStateIcon.js"

export interface RepoContextBarProps {
  readonly context?: WorkspaceGitContext
}

const BAR = "flex flex-none items-center gap-2 border-b border-border px-3 py-2 text-[12px]"

// Check rollup → octicon + colour. Mirrors summarizeChecks' three verdicts
// (and GitHub's own check-rollup glyphs: check-circle / x-circle / yellow dot).
const CHECKS: Record<string, { readonly Icon: Icon; readonly color: string }> = {
  passing: { Icon: CheckIcon, color: "text-ok" },
  failing: { Icon: XIcon, color: "text-danger" },
  pending: { Icon: DotFillIcon, color: "text-request" },
}

/** The git context strip at the top of the pane: the current branch and the PR
 * that branch maps to (number, title, state, checks, review). Renders nothing
 * when the workspace isn't a git repository. Purely presentational — the GitPane
 * owns the fetch and auto-syncs PRs on open. */
export function RepoContextBar({ context }: RepoContextBarProps): JSX.Element | null {
  if (!context?.repository) return null
  const { branch, currentPullRequest: pr } = context

  return (
    <div className={BAR}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {branch && (
          <span className="flex-none truncate font-mono text-[11px] text-fg-dim">{branch}</span>
        )}
        {pr && <PullRequestSummary pr={pr} />}
      </div>
    </div>
  )
}

function PullRequestSummary({ pr }: { readonly pr: PullRequest }): JSX.Element {
  const stateColor = prStateColor(pr.state, pr.isDraft)
  const body = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`flex-none inline-flex items-center gap-[3px] font-mono text-[11px] font-semibold ${stateColor}`}>
        <PrStateIcon state={pr.state} isDraft={pr.isDraft} />#{pr.number}
      </span>
      <span className="min-w-0 truncate text-foreground">{pr.title}</span>
      {pr.checksState &&
        CHECKS[pr.checksState] &&
        (() => {
          const { Icon, color } = CHECKS[pr.checksState]!
          return (
            <span className={`flex-none ${color}`} aria-label={`checks ${pr.checksState}`}>
              <Icon size={13} />
            </span>
          )
        })()}
      {pr.reviewState && (
        <span className="flex-none font-mono text-[10px] uppercase tracking-[0.04em] text-fg-dim">
          {pr.reviewState.replace(/_/g, " ")}
        </span>
      )}
    </span>
  )

  // Link out to the PR when we have a URL; Electron routes target=_blank through
  // the window open handler to the system browser.
  return pr.url ? (
    <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center no-underline">
      {body}
    </a>
  ) : (
    body
  )
}
