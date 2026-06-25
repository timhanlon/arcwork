import { Schema } from "effect"
import { ChatId, WorkspaceId } from "./ids.js"

/**
 * A Chat — the human-facing conversation thread and the unit target CLI sessions
 * correlate back to. Every launched CLI is stamped with the chat's id in its
 * environment (ARC_CHAT_ID), which its hook subprocesses inherit. That env stamp
 * is the deterministic attribution lever — it is how a captured native session
 * later joins back to "which arc chat". A chat may have many target sessions,
 * including multiple sessions for the same provider; `target_…` is the session
 * identity. Any "default provider session" behavior is a launch policy, not the
 * chat/session key.
 *
 * "channel" is deliberately NOT this; it is reserved for arc-message provenance
 * (user/review/ci/…) on injected messages.
 */
export const Chat = Schema.Struct({
  _tag: Schema.Literal("Chat"),
  id: ChatId,
  workspaceId: WorkspaceId,
  title: Schema.String,
  createdAt: Schema.String,
})
export type Chat = typeof Chat.Type
