import type { ComponentType, JSX } from "react"
import { CheckCircle, CircleDashed, XCircle, type IconProps } from "@phosphor-icons/react"
import type { PullRequest, WorkspaceGitContext } from "../../../shared/git.js"
import { Button } from "../ui/Button.js"

export interface RepoContextBarProps {
  readonly context?: WorkspaceGitContext
  readonly syncing: boolean
  readonly onSync: () => void
}

const BAR = "flex flex-none items-center gap-2 border-b border-border px-4 py-2 text-[12px]"

// PR state → label colour. Open is healthy, merged is the accent purple, closed
// is quiet.
const STATE_COLOR: Record<string, string> = {
  open: "text-ok",
  merged: "text-purple-400",
  closed: "text-fg-dim",
}

// Check rollup → icon + colour. Mirrors summarizeChecks' three verdicts.
const CHECKS: Record<string, { readonly Icon: ComponentType<IconProps>; readonly color: string }> = {
  passing: { Icon: CheckCircle, color: "text-ok" },
  failing: { Icon: XCircle, color: "text-danger" },
  pending: { Icon: CircleDashed, color: "text-request" },
}

/** The git context strip above the changed-file list: the repo slug, current
 * branch, and the PR that branch maps to (number, title, state, checks, review),
 * with a button to refresh PRs from GitHub. Renders nothing when the workspace
 * isn't a git repository. Purely presentational — the GitPane owns the fetch. */
export function RepoContextBar({ context, syncing, onSync }: RepoContextBarProps): JSX.Element | null {
  if (!context?.repository) return null
  const { repository, branch, currentPullRequest: pr } = context
  const slug =
    repository.githubOwner && repository.githubRepo
      ? `${repository.githubOwner}/${repository.githubRepo}`
      : null

  return (
    <div className={BAR}>
      <div className="flex min-w-0 flex-1 items-center gap-2">
        {slug && <span className="flex-none truncate font-mono text-[11px] text-fg-faint">{slug}</span>}
        {branch && (
          <span className="flex-none truncate font-mono text-[11px] text-fg-dim">{branch}</span>
        )}
        {pr ? <PullRequestSummary pr={pr} /> : <span className="text-fg-faint">No PR for this branch</span>}
      </div>
      <Button size="sm" variant="ghost" disabled={syncing} onClick={onSync}>
        {syncing ? "Syncing…" : "Sync PRs"}
      </Button>
    </div>
  )
}

function PullRequestSummary({ pr }: { readonly pr: PullRequest }): JSX.Element {
  const stateColor = STATE_COLOR[pr.state] ?? "text-fg-dim"
  const body = (
    <span className="flex min-w-0 items-center gap-1.5">
      <span className={`flex-none font-mono text-[11px] font-semibold ${stateColor}`}>#{pr.number}</span>
      <span className="min-w-0 truncate text-foreground">{pr.title}</span>
      {pr.isDraft && <span className="flex-none text-[10px] uppercase text-fg-faint">draft</span>}
      {pr.checksState &&
        CHECKS[pr.checksState] &&
        (() => {
          const { Icon, color } = CHECKS[pr.checksState]!
          return <Icon size={14} weight="fill" className={`flex-none ${color}`} aria-label={`checks ${pr.checksState}`} />
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
    <a href={pr.url} target="_blank" rel="noreferrer" className="flex min-w-0 items-center no-underline hover:underline">
      {body}
    </a>
  ) : (
    body
  )
}
