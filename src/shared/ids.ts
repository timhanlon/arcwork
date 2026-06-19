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
  // document-graph substrate: work ref identity, its revision nodes, and edges
  | "work"
  | "work_rev"
  | "work_edge"
  // a comment on a work revision node or its durable ref
  | "comment"

export const newArcId = (prefix: ArcIdPrefix): string => typeidUnboxed(prefix)
