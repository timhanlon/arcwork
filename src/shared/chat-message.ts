import { Schema } from "effect"
import { ChatRequest } from "./chat-request.js"
import { Provider } from "./provider.js"
import { ToolCall } from "./tool-call.js"

export const ChatMessageRole = Schema.Literals(["user", "assistant", "subagent", "request", "tool", "recap", "meta"])
export type ChatMessageRole = typeof ChatMessageRole.Type

export const ChatMessageStatus = Schema.Literals(["streaming", "pending", "final"])
export type ChatMessageStatus = typeof ChatMessageStatus.Type

/**
 * The structured payload of a `request`- or `tool`-role message, discriminated
 * on `kind` ("question" | "tool"). One field, decoded once from `request_json` —
 * the renderer dispatches on `payload.kind`, not the row's `role`.
 */
export const ChatMessagePayload = Schema.Union([ChatRequest, ToolCall])
export type ChatMessagePayload = typeof ChatMessagePayload.Type

/**
 * Hook-projected chat transcript row — user prompts, streaming assistant
 * chunks, and final turn repair from Stop / last_assistant_message.
 */
export const ChatMessage = Schema.Struct({
  _tag: Schema.Literal("ChatMessage"),
  id: Schema.String,
  chatId: Schema.String,
  targetSessionId: Schema.optional(Schema.String),
  role: ChatMessageRole,
  /** the target that emitted this row, derived at read from its target session
   * (`target_sessions.provider`) — session metadata, never stored in the payload.
   * Keys tool/request rows into the shared tool catalog; absent when the row has
   * no target session. */
  provider: Schema.optional(Provider),
  turnId: Schema.optional(Schema.String),
  messageId: Schema.optional(Schema.String),
  body: Schema.String,
  status: ChatMessageStatus,
  /** model that produced this row; set for assistant/subagent rows when the
   * provider's hook reports it, absent otherwise */
  model: Schema.optional(Schema.String),
  /** structured payload for `request`/`tool` rows, discriminated on `kind`;
   * absent for other roles */
  payload: Schema.optional(ChatMessagePayload),
  occurredAt: Schema.String,
  source: Schema.String,
})
export type ChatMessage = typeof ChatMessage.Type
