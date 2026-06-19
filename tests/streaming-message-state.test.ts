import { describe, expect, it } from "vitest"
import { hookSignalToAssistantStreamDelta } from "../src/main/hooks/assistant-stream-delta.js"
import type { HookSignal } from "../src/main/hooks/signals.js"
import type { ChatMessage } from "../src/shared/chat-message.js"
import type { AssistantStreamDelta } from "../src/shared/assistant-stream.js"
import {
  applyAssistantStreamDelta,
  dropHandedOffStreams,
} from "../src/renderer/src/chat/streaming-message-state.js"
import type { StreamingBuffer } from "../src/renderer/src/chat/streaming-message-state.js"

const delta = (overrides: Partial<AssistantStreamDelta> = {}): AssistantStreamDelta => ({
  chatId: "chat_01",
  targetSessionId: "target_01",
  messageId: "msg-1",
  delta: "",
  final: false,
  model: null,
  ...overrides,
})

const buffer = (overrides: Partial<StreamingBuffer> = {}): StreamingBuffer => ({
  targetSessionId: "target_01",
  messageId: "msg-1",
  text: "Let me search",
  ...overrides,
})

const message = (overrides: Partial<ChatMessage> = {}): ChatMessage => ({
  _tag: "ChatMessage",
  id: "m1",
  chatId: "chat_01",
  targetSessionId: "target_01",
  role: "assistant",
  body: "Let me search",
  status: "final",
  occurredAt: "2026-06-10T00:00:00.000Z",
  source: "artifact",
  ...overrides,
})

const withTarget = (body: Record<string, unknown>): HookSignal =>
  ({
    provider: "claude",
    declaredEvent: "MessageDisplay",
    arcChatSessionId: "chat_01",
    arcTargetSessionId: "target_01",
    arc: { chatId: "chat_01", targetSessionId: "target_01", targetProvider: "claude", hookSockPresent: true },
    native: { model: "claude-sonnet-4" },
    hookInput: body,
  }) as unknown as HookSignal

describe("applyAssistantStreamDelta", () => {
  it("accumulates deltas for the same message id", () => {
    const prev = applyAssistantStreamDelta([], delta({ delta: "Let " }))
    const next = applyAssistantStreamDelta(prev, delta({ delta: "me search" }))
    expect(next).toEqual([buffer({ text: "Let me search" })])
  })

  it("resets when a new message id arrives after a tool", () => {
    const prev = [buffer({ messageId: "msg-1", text: "Done." })]
    const next = applyAssistantStreamDelta(prev, delta({ messageId: "msg-2", delta: "Next" }))
    expect(next).toEqual([buffer({ messageId: "msg-2", text: "Next" })])
  })

  it("drops the target buffer when final is true", () => {
    const prev = [buffer()]
    const next = applyAssistantStreamDelta(prev, delta({ delta: "", final: true }))
    expect(next).toEqual([])
  })

  it("keeps another target streaming when one target finalizes", () => {
    const prev = [
      buffer({ targetSessionId: "target_01", messageId: "msg-1", text: "first" }),
      buffer({ targetSessionId: "target_02", messageId: "msg-9", text: "other" }),
    ]
    const next = applyAssistantStreamDelta(
      prev,
      delta({ targetSessionId: "target_01", messageId: "msg-1", final: true }),
    )
    expect(next).toEqual([buffer({ targetSessionId: "target_02", messageId: "msg-9", text: "other" })])
  })
})

describe("dropHandedOffStreams", () => {
  it("drops when the assistant bubble has landed", () => {
    const next = dropHandedOffStreams([buffer()], [message()])
    expect(next).toEqual([])
  })

  it("drops when a pending tool row appears for the same target", () => {
    const next = dropHandedOffStreams(
      [buffer()],
      [
        message({
          role: "tool",
          status: "pending",
          body: "Read",
          payload: { kind: "tool", toolName: "Read", state: "input-available" },
        }),
      ],
    )
    expect(next).toEqual([])
  })

  it("keeps streaming when an older final tool exists for the target", () => {
    const next = dropHandedOffStreams(
      [buffer({ text: "Continuing" })],
      [
        message({
          role: "tool",
          status: "final",
          body: "Read",
          payload: { kind: "tool", toolName: "Read", state: "output-available" },
        }),
      ],
    )
    expect(next).toEqual([buffer({ text: "Continuing" })])
  })
})

describe("hookSignalToAssistantStreamDelta", () => {
  it("maps MessageDisplay payloads with text", () => {
    expect(
      hookSignalToAssistantStreamDelta(
        withTarget({
          message_id: "msg-1",
          delta: "Hi",
          final: false,
        }),
      ),
    ).toEqual({
      chatId: "chat_01",
      targetSessionId: "target_01",
      messageId: "msg-1",
      delta: "Hi",
      final: false,
      model: "claude-sonnet-4",
    })
  })

  it("broadcasts a final-only marker with an empty delta", () => {
    expect(
      hookSignalToAssistantStreamDelta(
        withTarget({
          message_id: "msg-1",
          final: true,
        }),
      ),
    ).toEqual({
      chatId: "chat_01",
      targetSessionId: "target_01",
      messageId: "msg-1",
      delta: "",
      final: true,
      model: "claude-sonnet-4",
    })
  })
})
