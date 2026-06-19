import { Schema } from "effect"

/**
 * A Chat — the human-facing conversation thread and the unit target CLI sessions
 * correlate back to. A chat drives up to one interactive session per provider
 * (keyed `(chatId, provider)`), and every launched CLI is stamped with the
 * chat's id in its environment (ARC_CHAT_ID), which its hook subprocesses
 * inherit. That env stamp is the deterministic attribution lever — it is how a
 * captured native session later joins back to "which arc chat".
 *
 * "channel" is deliberately NOT this; it is reserved for arc-message provenance
 * (user/review/ci/…) on injected messages.
 */
export const Chat = Schema.Struct({
  _tag: Schema.Literal("Chat"),
  id: Schema.String, // TypeID prefix: chat
  workspaceId: Schema.String,
  title: Schema.String,
  createdAt: Schema.String,
})
export type Chat = typeof Chat.Type
