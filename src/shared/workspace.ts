import { Schema } from "effect"
import { PullRequest } from "./git.js"

/**
 * The slice of a branch's open pull request the sidebar needs: enough to render
 * a chip (number, draft/state colour) and link out (`url`), with the title for a
 * tooltip. The Git pane reads the full {@link PullRequest} via `gitContext`; this
 * rides the workspace stream so the tree can show it without a per-row fetch.
 *
 * Each field is sourced from {@link PullRequest} so the two can't drift — this is
 * a strict projection of it, not a parallel declaration.
 */
export const WorkspacePullRequest = Schema.Struct({
  number: PullRequest.fields.number,
  title: PullRequest.fields.title,
  state: PullRequest.fields.state,
  isDraft: PullRequest.fields.isDraft,
  url: PullRequest.fields.url,
})
export type WorkspacePullRequest = typeof WorkspacePullRequest.Type

/**
 * A workspace is the directory used as the cwd for launched target CLIs (and,
 * later, the key for artifact/session scoping — the workspace-slug contract).
 * Multiple workspaces can be open concurrently; chats are scoped to one.
 */
export const Workspace = Schema.Struct({
  id: Schema.String, // TypeID prefix: workspace
  path: Schema.String,
  name: Schema.String, // basename, for display
  // Repository identity — the grouping key for the sidebar's project tier.
  // Null for a plain (non-git) folder, which stays ungrouped. `repoLabel` is
  // the project header (`owner/repo` when GitHub identity is known, else the
  // repo root basename); `branch` is this workspace's checked-out branch and
  // `isWorktree` distinguishes a linked worktree from the repo's main checkout.
  repositoryId: Schema.NullOr(Schema.String),
  repoLabel: Schema.NullOr(Schema.String),
  defaultBranch: Schema.NullOr(Schema.String),
  branch: Schema.NullOr(Schema.String),
  isWorktree: Schema.Boolean,
  // The open PR for this workspace's branch, when one is known to the read model
  // (populated by `syncPullRequests`). Null otherwise.
  pullRequest: Schema.NullOr(WorkspacePullRequest),
})
export type Workspace = typeof Workspace.Type
