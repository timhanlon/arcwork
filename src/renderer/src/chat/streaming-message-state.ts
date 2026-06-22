import type { AssistantStreamDelta } from "../../../shared/assistant-stream.js"
import type { TargetId } from "../../../shared/ids.js"
import type { ChatMessage } from "../../../shared/chat-message.js"

/** One in-flight assistant block being streamed live for a target session. */
export interface StreamingBuffer {
  readonly targetSessionId: TargetId
  readonly messageId: string | null
  readonly text: string
  readonly model?: string
}

// How much of the live text to match against a persisted bubble for handoff. A
// prefix is enough to recognize the block, and bounding it keeps the scan cheap.
export const STREAM_HANDOFF_PREFIX = 200

/** Apply one live assistant delta to the per-target stream buffers. */
export const applyAssistantStreamDelta = (
  prev: ReadonlyArray<StreamingBuffer>,
  delta: AssistantStreamDelta,
): ReadonlyArray<StreamingBuffer> => {
  const targetSessionId = delta.targetSessionId
  if (!targetSessionId) return prev

  if (delta.final) {
    return prev.filter(
      (s) =>
        s.targetSessionId !== targetSessionId ||
        (delta.messageId != null && s.messageId !== delta.messageId),
    )
  }

  const idx = prev.findIndex((s) => s.targetSessionId === targetSessionId)
  if (idx === -1) {
    return [
      ...prev,
      {
        targetSessionId,
        messageId: delta.messageId,
        text: delta.delta,
        ...(delta.model ? { model: delta.model } : {}),
      },
    ]
  }

  const cur = prev[idx]!
  // A new message id means a new block began (e.g. text after a tool) — reset
  // rather than concatenate across blocks.
  const sameBlock = delta.messageId === null || cur.messageId === delta.messageId
  const next: StreamingBuffer = {
    targetSessionId,
    messageId: delta.messageId ?? cur.messageId,
    text: sameBlock ? cur.text + delta.delta : delta.delta,
    ...(delta.model ?? cur.model ? { model: delta.model ?? cur.model } : {}),
  }
  const copy = prev.slice()
  copy[idx] = next
  return copy
}

/** Drop buffers whose text has landed in the transcript or whose turn moved on. */
export const dropHandedOffStreams = (
  prev: ReadonlyArray<StreamingBuffer>,
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<StreamingBuffer> =>
  prev.filter((s) => {
    const probe = s.text.trim().slice(0, STREAM_HANDOFF_PREFIX)
    if (probe) {
      const landed = messages.some(
        (m) =>
          m.role === "assistant" &&
          m.targetSessionId === s.targetSessionId &&
          m.body.includes(probe),
      )
      if (landed) return false
    }
    // A pending tool/question row means the model left the text block — close the
    // overlay even if artifact projection has not caught up yet.
    const toolStarted = messages.some(
      (m) =>
        (m.role === "tool" || m.role === "request") &&
        m.status === "pending" &&
        m.targetSessionId === s.targetSessionId,
    )
    return !toolStarted
  })
