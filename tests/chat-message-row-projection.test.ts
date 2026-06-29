import { describe, expect, it } from "vitest"
import {
  asProvider,
  isUndecodableRequestRow,
  parsePayload,
  pendingRequestKind,
  rowToChatMessage,
  titleSeedFromMessages,
} from "../src/main/services/chat-message/row-projection.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

const row = (over: Partial<ChatMessageRow>): ChatMessageRow => ({
  id: arcId("message", "message_01"),
  chatId: arcId("chat", "chat_01"),
  targetSessionId: arcId("target", "target_01"),
  role: "assistant",
  turnId: null,
  messageId: null,
  chunkIndex: null,
  body: "hello",
  status: "final",
  model: null,
  requestJson: null,
  injectedFromTargetSessionId: null,
  injectedTargetMessageId: null,
  occurredAt: "2026-06-11T00:00:00.000Z",
  source: "artifact:claude",
  dedupKey: "target_01:assistant:message_01",
  ...over,
})

// A question payload that decodes against the request union.
const questionJson = JSON.stringify({
  kind: "question",
  state: "pending",
  title: "Pick",
  questions: [{ prompt: "A or B?", options: [{ label: "A", value: "A" }, { label: "B", value: "B" }] }],
})

describe("chat-message row projection", () => {
  it("decodes a valid request payload and degrades a malformed one to undefined", () => {
    expect(parsePayload(questionJson)?.kind).toBe("question")
    expect(parsePayload(null)).toBeUndefined()
    expect(parsePayload("{not json")).toBeUndefined()
    expect(parsePayload(JSON.stringify({ kind: "permission", foo: 1 }))).toBeUndefined()
  })

  it("hides only request rows whose payload no longer decodes", () => {
    expect(isUndecodableRequestRow(row({ role: "request", requestJson: questionJson }))).toBe(false)
    expect(isUndecodableRequestRow(row({ role: "request", requestJson: null }))).toBe(true)
    expect(isUndecodableRequestRow(row({ role: "request", requestJson: "{legacy" }))).toBe(true)
    // Non-request rows are always shown, even without a payload.
    expect(isUndecodableRequestRow(row({ role: "assistant", requestJson: null }))).toBe(false)
  })

  it("narrows the bare provider column to the closed union, dropping the unknown", () => {
    expect(asProvider("claude")).toBe("claude")
    expect(asProvider("cursor")).toBe("cursor")
    expect(asProvider("totally-unknown")).toBeUndefined()
    expect(asProvider(null)).toBeUndefined()
    expect(asProvider(undefined)).toBeUndefined()
  })

  it("every persisted pending request classifies as a question", () => {
    expect(pendingRequestKind(null)).toBe("question")
    expect(pendingRequestKind(questionJson)).toBe("question")
  })

  it("derives the message envelope from the row, with provider only when supplied", () => {
    const withProvider = rowToChatMessage(row({ role: "tool", requestJson: null }), "claude")
    expect(withProvider).toMatchObject({
      _tag: "ChatMessage",
      id: "message_01",
      chatId: "chat_01",
      targetSessionId: "target_01",
      provider: "claude",
      role: "tool",
      body: "hello",
      status: "final",
      source: "artifact:claude",
    })
    // No provider key at all when none is derived (rather than provider: undefined).
    expect("provider" in rowToChatMessage(row({}))).toBe(false)
  })

  it("seeds the title from the earliest final user prompts, oldest first", () => {
    const seed = titleSeedFromMessages(
      [
        row({ id: arcId("message", "b"), role: "user", body: "second", occurredAt: "2026-06-11T00:00:02.000Z" }),
        row({ id: arcId("message", "a"), role: "user", body: "first", occurredAt: "2026-06-11T00:00:01.000Z" }),
        row({ id: arcId("message", "c"), role: "assistant", body: "ignored", occurredAt: "2026-06-11T00:00:03.000Z" }),
        row({ id: arcId("message", "d"), role: "user", status: "pending", body: "not-final", occurredAt: "2026-06-11T00:00:00.500Z" }),
      ],
      "fallback",
    )
    expect(seed).toBe("first\n\nsecond")
  })

  it("falls back to the provided seed when no final user prompt exists", () => {
    expect(titleSeedFromMessages([row({ role: "assistant" })], "the fallback")).toBe("the fallback")
  })
})
