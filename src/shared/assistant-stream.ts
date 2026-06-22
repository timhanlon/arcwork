/**
 * A live assistant-text delta, broadcast on `arc:assistant-stream` for the
 * in-flight turn. This is the ephemeral render-only stream that feeds the
 * StreamingMessage above the composer — it is NEVER persisted as a chat_messages
 * row. The durable bubble comes from the transcript (artifact projection); see
 * ChatMessageService.projectArtifactSession's assistant branch.
 *
 * Only providers whose hooks stream tokens emit these (Claude's MessageDisplay).
 * Codex/Cursor have no token stream, so their reply simply lands from disk.
 *
 * Like `arc:pty-data`, this rides the raw broadcast plane without Schema decode —
 * a dropped/garbled delta only affects a transient visual, never stored state.
 */
import type { ChatId, TargetId } from "./ids.js"

export interface AssistantStreamDelta {
  /** chat this delta belongs to (null only if the hook lacked arc env) */
  readonly chatId: ChatId | null
  /** target session producing the stream */
  readonly targetSessionId: TargetId | null
  /** provider stream id for the message being streamed (coalesces deltas) */
  readonly messageId: string | null
  /** the incremental text chunk */
  readonly delta: string
  /** the final delta of this message — the block is complete */
  readonly final: boolean
  /** model producing the stream, when the hook reports it */
  readonly model: string | null
}
