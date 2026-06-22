import { Schema } from "effect"

export const GitChangeStatus = Schema.Literals([
  "added",
  "modified",
  "deleted",
  "renamed",
  "copied",
  "untracked",
  "unmerged",
  "typeChange",
  "unknown",
])
export type GitChangeStatus = typeof GitChangeStatus.Type

export const GitFileChange = Schema.Struct({
  path: Schema.String,
  originalPath: Schema.optional(Schema.String),
  status: GitChangeStatus,
  staged: Schema.Boolean,
  unstaged: Schema.Boolean,
  added: Schema.Number,
  deleted: Schema.Number,
  isBinary: Schema.Boolean,
})
export type GitFileChange = typeof GitFileChange.Type

export const GitStatus = Schema.Struct({
  workspaceId: Schema.String,
  workspaceName: Schema.String,
  branch: Schema.optional(Schema.String),
  head: Schema.optional(Schema.String),
  isRepo: Schema.Boolean,
  changes: Schema.Array(GitFileChange),
})
export type GitStatus = typeof GitStatus.Type

export const GitFileDiff = Schema.Struct({
  path: Schema.String,
  diff: Schema.String,
})
export type GitFileDiff = typeof GitFileDiff.Type

/** One commit on the workspace's current branch, for the Git pane's history
 * list. `shortSha` is git's abbreviated hash; `authoredAt` is ISO-8601. */
export const GitCommit = Schema.Struct({
  sha: Schema.String,
  shortSha: Schema.String,
  subject: Schema.String,
  author: Schema.String,
  authoredAt: Schema.String,
})
export type GitCommit = typeof GitCommit.Type

/** A local clone's identity for the renderer — the durable read-model fields,
 * minus internals (common git dir, remotes blob, timestamps). */
export const Repository = Schema.Struct({
  id: Schema.String,
  rootPath: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  githubOwner: Schema.NullOr(Schema.String),
  githubRepo: Schema.NullOr(Schema.String),
})
export type Repository = typeof Repository.Type

/** A git worktree under a repository, with its lifecycle flags as booleans. */
export const Worktree = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  isDetached: Schema.Boolean,
  isLocked: Schema.Boolean,
  isPrunable: Schema.Boolean,
})
export type Worktree = typeof Worktree.Type

/** The GitHub PR read model as the renderer sees it. */
export const PullRequest = Schema.Struct({
  id: Schema.String,
  number: Schema.Number,
  title: Schema.String,
  state: Schema.String,
  isDraft: Schema.Boolean,
  author: Schema.NullOr(Schema.String),
  headRef: Schema.String,
  baseRef: Schema.String,
  reviewState: Schema.NullOr(Schema.String),
  checksState: Schema.NullOr(Schema.String),
  mergeable: Schema.NullOr(Schema.String),
  url: Schema.NullOr(Schema.String),
  updatedAt: Schema.String,
})
export type PullRequest = typeof PullRequest.Type

/** The assembled git context for one workspace: its clone, the worktrees under
 * that clone, the workspace's current branch, and the open PR that branch maps
 * to (if any). `repository` is null when the workspace cwd is not a git repo. */
export const WorkspaceGitContext = Schema.Struct({
  workspaceId: Schema.String,
  branch: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Repository),
  worktrees: Schema.Array(Worktree),
  currentPullRequest: Schema.NullOr(PullRequest),
})
export type WorkspaceGitContext = typeof WorkspaceGitContext.Type
