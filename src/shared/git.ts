import { Schema } from "effect"
import { WorkspaceId } from "./ids.js"

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
