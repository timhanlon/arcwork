import { useEffect, useState } from "react"
import type { ChatMessage } from "../../../shared/chat-message.js"
import { subscribeWhenReady } from "../bridge.js"
import { applyAssistantStreamDelta, dropHandedOffStreams, type StreamingBuffer } from "./streaming-message-state.js"

export type { StreamingBuffer } from "./streaming-message-state.js"

/**
 * Live, render-only assistant streams for a chat. Deltas arrive on
 * `arc:assistant-stream` (Claude only) and accumulate per target; this never
 * touches the store. A buffer is dropped when the hook marks the block `final`,
 * when a pending tool/question row lands for that target, or on coarse handoff
 * once the transcript's persisted assistant bubble catches up to the streamed
 * text.
 */
export function useStreamingMessages(
  chatId: string | undefined,
  messages: ReadonlyArray<ChatMessage>,
): ReadonlyArray<StreamingBuffer> {
  const [streams, setStreams] = useState<ReadonlyArray<StreamingBuffer>>([])

  useEffect(() => {
    if (!chatId) {
      setStreams([])
      return
    }
    const unsub = subscribeWhenReady((arc) =>
      arc.onAssistantStream((delta) => {
        if (delta.chatId !== chatId) return
        setStreams((prev) => applyAssistantStreamDelta(prev, delta))
      }),
    )
    return () => {
      unsub()
      setStreams([])
    }
  }, [chatId])

  useEffect(() => {
    setStreams((prev) => {
      const next = dropHandedOffStreams(prev, messages)
      return next.length === prev.length ? prev : next
    })
  }, [messages])

  return streams
}
