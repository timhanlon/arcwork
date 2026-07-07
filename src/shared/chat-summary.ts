import { Schema } from "effect"
import { ChatId, SummaryId } from "./ids.js"

/** Token accounting from the completion, when the server reports it (some
 * OpenAI-compatible servers omit `usage`), so either field may be null. */
export const ChatSummaryUsage = Schema.Struct({
  promptTokens: Schema.NullOr(Schema.Number),
  completionTokens: Schema.NullOr(Schema.Number),
})
export type ChatSummaryUsage = typeof ChatSummaryUsage.Type

/**
 * A distilled chat summary crossing the Rpc seam — the persisted `summary` graph
 * node hydrated with its metadata. `inputHash` + `model` + `promptVersion`
 * identify what produced it (and form its idempotency key with the chat).
 */
export const ChatSummary = Schema.Struct({
  _tag: Schema.Literal("ChatSummary"),
  id: SummaryId,
  chatId: ChatId,
  /** the summary markdown */
  body: Schema.String,
  model: Schema.String,
  promptVersion: Schema.Number,
  inputHash: Schema.String,
  usage: ChatSummaryUsage,
  /** wall-clock ms the local completion took; null when not recorded */
  durationMs: Schema.NullOr(Schema.Number),
  createdAt: Schema.String,
})
export type ChatSummary = typeof ChatSummary.Type
