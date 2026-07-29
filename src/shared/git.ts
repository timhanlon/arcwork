import { Schema } from "effect"
import { PrId, RepositoryId, WorkspaceId, WorktreeId } from "./ids.js"

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
  workspaceId: WorkspaceId,
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

// ── Diff tree ────────────────────────────────────────────────────────────────
//
// The diff tree answers "how much energy does this change need?" before you read
// a line of it. Line counts alone can't: a 9k-line lockfile bump and a 200-line
// rewrite of the billing core look the same in `+/-`. So the tree separates what
// a human actually authored from what a tool emitted, groups the authored files
// into modules, and — when the `sem` binary is present — counts the *code
// entities* (functions, classes, tests) that moved rather than the lines.

/** What a changed file is, for grouping, ordering, and its row icon. `generated`
 * is the quarantine bucket: lockfiles, build output, generated clients. It is a
 * file kind rather than a flag because it also decides ordering (always last)
 * and default collapse. */
export const DiffFileKind = Schema.Literals(["source", "test", "schema", "config", "docs", "generated"])
export type DiffFileKind = typeof DiffFileKind.Type

/** Entity-level movement within one file, from `sem diff`. `structural` counts
 * entities whose parse tree actually changed; `cosmetic` counts the rest
 * (reformatting, comment edits) — a file that is all-cosmetic is the clearest
 * "skip this one" signal the tree can give. */
export const DiffEntityStats = Schema.Struct({
  added: Schema.Number,
  modified: Schema.Number,
  removed: Schema.Number,
  moved: Schema.Number,
  structural: Schema.Number,
  cosmetic: Schema.Number,
})
export type DiffEntityStats = typeof DiffEntityStats.Type

/** One changed file as a tree leaf. `entities` is null when `sem` is absent or
 * the file's language has no parser — the row then falls back to line counts. */
export const DiffTreeFile = Schema.Struct({
  path: Schema.String,
  /** Path relative to its group's label, so rows render short under the header. */
  displayPath: Schema.String,
  originalPath: Schema.NullOr(Schema.String),
  status: GitChangeStatus,
  kind: DiffFileKind,
  added: Schema.Number,
  deleted: Schema.Number,
  isBinary: Schema.Boolean,
  entities: Schema.NullOr(DiffEntityStats),
  /** A few named entities that moved, for the row's subtitle — the thing that
   * makes a row readable without opening the diff ("proration, applyCredit"). */
  topEntities: Schema.Array(Schema.String),
})
export type DiffTreeFile = typeof DiffTreeFile.Type

/** A module group — a directory subtree whose files are read together, or a
 * single standalone file that earns its own row (a migration, a config). */
export const DiffTreeGroup = Schema.Struct({
  id: Schema.String,
  /** Directory path (trailing slash) or the file path for a standalone group. */
  label: Schema.String,
  /** One-line rationale shown under the label. Rule-derived, never invented. */
  caption: Schema.NullOr(Schema.String),
  kind: DiffFileKind,
  added: Schema.Number,
  deleted: Schema.Number,
  entitiesChanged: Schema.Number,
  /** Generated groups collapse by default so they can't dominate the view. */
  defaultCollapsed: Schema.Boolean,
  files: Schema.Array(DiffTreeFile),
})
export type DiffTreeGroup = typeof DiffTreeGroup.Type

/** The headline tiles for the current working tree. */
export const DiffTreeStats = Schema.Struct({
  modules: Schema.Number,
  authoredFiles: Schema.Number,
  generatedFiles: Schema.Number,
  entitiesChanged: Schema.Number,
  /** Files whose every entity change was cosmetic — safe to skim. */
  cosmeticOnlyFiles: Schema.Number,
})
export type DiffTreeStats = typeof DiffTreeStats.Type

export const DiffTree = Schema.Struct({
  workspaceId: WorkspaceId,
  added: Schema.Number,
  deleted: Schema.Number,
  stats: DiffTreeStats,
  groups: Schema.Array(DiffTreeGroup),
  /** False when the `sem` binary is missing or failed — the tree still renders,
   * with line counts only and no entity/cosmetic signal. */
  semAvailable: Schema.Boolean,
})
export type DiffTree = typeof DiffTree.Type

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
  id: RepositoryId,
  rootPath: Schema.String,
  defaultBranch: Schema.NullOr(Schema.String),
  githubOwner: Schema.NullOr(Schema.String),
  githubRepo: Schema.NullOr(Schema.String),
})
export type Repository = typeof Repository.Type

/** A git worktree under a repository, with its lifecycle flags as booleans. */
export const Worktree = Schema.Struct({
  id: WorktreeId,
  path: Schema.String,
  branch: Schema.NullOr(Schema.String),
  headSha: Schema.NullOr(Schema.String),
  isDetached: Schema.Boolean,
  isLocked: Schema.Boolean,
  isPrunable: Schema.Boolean,
})
export type Worktree = typeof Worktree.Type

/** A pull request's lifecycle state, as GitHub models it. */
export const PrState = Schema.Literals(["open", "merged", "closed"])
export type PrState = typeof PrState.Type

/** Narrow an arbitrary (already-lowercased) GitHub PR state to a `PrState`, or
 * null when it isn't one of the three. The wire projection coerces here so the
 * renderer never re-validates per call site. */
export const toPrState = (state: string): PrState | null =>
  state === "open" || state === "merged" || state === "closed" ? state : null

/** The GitHub PR read model as the renderer sees it. */
export const PullRequest = Schema.Struct({
  id: PrId,
  number: Schema.Number,
  title: Schema.String,
  state: PrState,
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
  workspaceId: WorkspaceId,
  branch: Schema.NullOr(Schema.String),
  repository: Schema.NullOr(Repository),
  worktrees: Schema.Array(Worktree),
  currentPullRequest: Schema.NullOr(PullRequest),
})
export type WorkspaceGitContext = typeof WorkspaceGitContext.Type
