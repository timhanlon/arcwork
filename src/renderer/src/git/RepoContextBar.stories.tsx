import type { PullRequest, WorkspaceGitContext } from "../../../shared/git.js"
import { RepoContextBar } from "./RepoContextBar.js"

export default {
  title: "Git / RepoContextBar",
}

const repository: WorkspaceGitContext["repository"] = {
  id: "repo_1",
  rootPath: "/Users/tim/dev/aux",
  defaultBranch: "main",
  githubOwner: "twofutures",
  githubRepo: "arc-electron",
}

const pr = (overrides: Partial<PullRequest>): PullRequest => ({
  id: "pr_1",
  number: 128,
  title: "Make GitHub PRs and Git worktrees first-class",
  state: "open",
  isDraft: false,
  author: "tim",
  headRef: "feat/git",
  baseRef: "main",
  reviewState: null,
  checksState: null,
  mergeable: "mergeable",
  url: "https://github.com/twofutures/arc-electron/pull/128",
  updatedAt: "2026-06-19T12:00:00.000Z",
  ...overrides,
})

const context = (overrides: Partial<WorkspaceGitContext>): WorkspaceGitContext => ({
  workspaceId: "workspace_1",
  branch: "feat/git",
  repository,
  worktrees: [],
  currentPullRequest: null,
  ...overrides,
})

const noop = () => {}

const Frame = ({ children }: { children: React.ReactNode }) => (
  <div style={{ width: 520, background: "var(--background)" }}>{children}</div>
)

/** Open PR, checks passing, approved — the happy path. */
export const OpenApprovedPassing = () => (
  <Frame>
    <RepoContextBar
      context={context({ currentPullRequest: pr({ checksState: "passing", reviewState: "approved" }) })}
      syncing={false}
      onSync={noop}
    />
  </Frame>
)

/** Checks failing, changes requested. */
export const FailingChangesRequested = () => (
  <Frame>
    <RepoContextBar
      context={context({
        currentPullRequest: pr({ checksState: "failing", reviewState: "changes_requested" }),
      })}
      syncing={false}
      onSync={noop}
    />
  </Frame>
)

/** Draft PR with checks still running. */
export const DraftPending = () => (
  <Frame>
    <RepoContextBar
      context={context({ currentPullRequest: pr({ isDraft: true, checksState: "pending" }) })}
      syncing={false}
      onSync={noop}
    />
  </Frame>
)

/** On a branch with no PR yet. */
export const NoPullRequest = () => (
  <Frame>
    <RepoContextBar context={context({ currentPullRequest: null })} syncing={false} onSync={noop} />
  </Frame>
)

/** Mid-sync (button disabled). */
export const Syncing = () => (
  <Frame>
    <RepoContextBar
      context={context({ currentPullRequest: pr({ checksState: "passing" }) })}
      syncing
      onSync={noop}
    />
  </Frame>
)

/** A local repo with no GitHub remote — slug omitted, no PR. */
export const NoGitHubRemote = () => (
  <Frame>
    <RepoContextBar
      context={context({ repository: { ...repository, githubOwner: null, githubRepo: null } })}
      syncing={false}
      onSync={noop}
    />
  </Frame>
)

/** Not a git repository — renders nothing. */
export const NotARepo = () => (
  <Frame>
    <RepoContextBar context={context({ repository: null })} syncing={false} onSync={noop} />
  </Frame>
)
