import { Schema } from "effect"

/**
 * Normalized activity fact derived from target hooks — the durable chat
 * timeline the unified center pane projects.
 */
export const ActivityEvent = Schema.Struct({
  _tag: Schema.Literal("ActivityEvent"),
  id: Schema.String,
  chatId: Schema.optional(Schema.String),
  targetSessionId: Schema.optional(Schema.String),
  source: Schema.String,
  kind: Schema.String,
  actor: Schema.optional(Schema.String),
  occurredAt: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
})
export type ActivityEvent = typeof ActivityEvent.Type
