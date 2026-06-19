import { describe, expect, it } from "vitest"
import { hookSignalToChatMessageDrafts } from "../src/main/hooks/chat-message.js"
import { composerOptimisticUserKey } from "../src/main/chat-message-keys.js"
import { toSignal } from "../src/main/hooks/signals.js"

const wire = (body: Record<string, unknown>): string => JSON.stringify(body)

const parseSignal = (body: Record<string, unknown>) => {
  const result = toSignal(wire(body))
  if (!result.ok) throw new Error(result.reason)
  return result.signal
}

describe("composer prompt keys", () => {
  it("uses distinct optimistic keys per composer message", () => {
    expect(composerOptimisticUserKey("target_01", "msg_a")).not.toBe(
      composerOptimisticUserKey("target_01", "msg_b"),
    )
  })

  // User text moved off the hook stream: the transcript is the single source of
  // truth (projectArtifactSession's user branch), keyed by the message uuid —
  // unique per submit even for identical text, so two identical prompts no longer
  // collide. The hook's content-hash turn fallback (which caused that collision)
  // is gone, so UserPromptSubmit drafts nothing.
  it("does not draft a user bubble from a Claude UserPromptSubmit", () => {
    const signal = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "UserPromptSubmit",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "msg-user",
      hookInput: { prompt: "Hello", turn_id: "turn-1" },
      arc: {
        chatId: "chat_01",
        targetSessionId: "target_01",
        targetProvider: "claude",
        hookSockPresent: true,
      },
      arcTargetSessionId: "target_01",
    })

    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })
})

describe("assistant text is artifact-owned, not hook-projected", () => {
  // Assistant text moved off the hook stream: the transcript is the single
  // source of truth (projectArtifactSession's assistant branch), so the hook
  // no longer drafts an assistant bubble. Model attribution now rides the
  // artifact `MessageRow.model` and the live `arc:assistant-stream` delta.
  it("does not draft an assistant bubble from a Codex Stop", () => {
    const signal = parseSignal({
      declaredProvider: "codex",
      declaredEvent: "Stop",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "msg-stop",
      hookInput: {
        last_assistant_message: "Done.",
        turn_id: "turn-1",
        model: "gpt-5.4-codex",
      },
      arc: {
        chatId: "chat_01",
        targetSessionId: "target_01",
        targetProvider: "codex",
        hookSockPresent: true,
      },
      arcTargetSessionId: "target_01",
    })

    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })
})
