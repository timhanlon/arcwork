import { Schema } from "effect"

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
})
export type Workspace = typeof Workspace.Type
