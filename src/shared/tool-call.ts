import { Schema } from "effect"

export const ToolCallState = Schema.Literals([
  "input-available",
  "approval-requested",
  "output-available",
  "output-error",
  "output-denied",
])
export type ToolCallState = typeof ToolCallState.Type

/** One image a tool result carried, referenced by content hash (bytes live in
 * the on-disk cache, served over `arc-img://cache/<hash>.<ext>`). */
export const ToolCallImage = Schema.Struct({
  hash: Schema.String,
  mediaType: Schema.String,
})
export type ToolCallImage = typeof ToolCallImage.Type

export const ToolCall = Schema.Struct({
  kind: Schema.Literal("tool"),
  state: ToolCallState,
  toolName: Schema.String,
  args: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.String),
  /** Images the result carried (a Read of a `.png`, a browser screenshot),
   * rendered inline in place of the old `[image]` text. */
  images: Schema.optional(Schema.Array(ToolCallImage)),
})
export type ToolCall = typeof ToolCall.Type
