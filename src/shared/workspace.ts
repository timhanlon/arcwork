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
})
export type Workspace = typeof Workspace.Type
