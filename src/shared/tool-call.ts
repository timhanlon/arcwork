import { Schema } from "effect"

export const ToolCallState = Schema.Literals([
  "input-available",
  "approval-requested",
  "output-available",
  "output-error",
  "output-denied",
])
export type ToolCallState = typeof ToolCallState.Type

export const ToolCall = Schema.Struct({
  kind: Schema.Literal("tool"),
  state: ToolCallState,
  toolName: Schema.String,
  args: Schema.optional(Schema.Unknown),
  output: Schema.optional(Schema.String),
})
export type ToolCall = typeof ToolCall.Type
