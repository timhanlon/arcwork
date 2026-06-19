import { typeidUnboxed } from "typeid-js"

export type ArcIdPrefix =
  | "activity"
  | "chat"
  | "hook"
  | "message"
  | "pane"
  | "run"
  | "target"
  | "workspace"
  // git/github domain read model: a local clone, its worktrees, and a synced PR
  | "repo"
  | "worktree"
  | "pr"
  // document-graph substrate: work ref identity, its revision nodes, and edges
  | "work"
  | "work_rev"
  | "work_edge"
  // a comment on a work revision node or its durable ref
  | "comment"

export const newArcId = (prefix: ArcIdPrefix): string => typeidUnboxed(prefix)
