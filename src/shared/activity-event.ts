import { Schema } from "effect"
import { ActivityId, ChatId, TargetId } from "./ids.js"

/**
 * Normalized activity fact derived from target hooks — the durable chat
 * timeline the unified center pane projects.
 */
export const ActivityEvent = Schema.Struct({
  _tag: Schema.Literal("ActivityEvent"),
  id: ActivityId,
  chatId: Schema.optional(ChatId),
  targetSessionId: Schema.optional(TargetId),
  source: Schema.String,
  kind: Schema.String,
  actor: Schema.optional(Schema.String),
  occurredAt: Schema.String,
  payload: Schema.Record(Schema.String, Schema.Unknown),
})
export type ActivityEvent = typeof ActivityEvent.Type
