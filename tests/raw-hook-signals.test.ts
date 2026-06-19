import { describe, expect, it } from "vitest"
import { hookSignalToActivityDrafts } from "../src/main/hooks/agent-event.js"
import { hookSignalToChatMessageDrafts } from "../src/main/hooks/chat-message.js"
import {
  rawHookSignalPayloadJson,
  rawHookSignalRowFrom,
} from "../src/main/hooks/raw-hook-signal.js"
import { toSignal } from "../src/main/hooks/signals.js"

const wire = (body: Record<string, unknown>): string => JSON.stringify(body)

const parseSignal = (body: Record<string, unknown>) => {
  const result = toSignal(wire(body))
  if (!result.ok) throw new Error(result.reason)
  return result.signal
}

const withTarget = (body: Record<string, unknown>) =>
  parseSignal({
    ...body,
    arc: {
      chatId: "chat_01",
      targetSessionId: "target_01",
      targetProvider: "cursor",
      hookSockPresent: true,
    },
    arcTargetSessionId: "target_01",
    arcChatSessionId: "chat_01",
    arcTargetProvider: "cursor",
  })

describe("raw hook signal persistence", () => {
  it("builds an unredacted payload with the full helper envelope", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "preToolUse",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-pretool",
      hookInputParseOk: true,
      hookInput: {
        conversation_id: "conv-1",
        hook_event_name: "preToolUse",
        tool_name: "AskQuestion",
        tool_input: { questions: [{ prompt: "Pick one", options: ["a", "b"] }] },
        cursor_version: "1.0.0",
      },
    })

    const payload = JSON.parse(rawHookSignalPayloadJson(signal)) as {
      envelope: Record<string, unknown>
      hookInput: Record<string, unknown>
    }

    expect(payload.hookInput["tool_name"]).toBe("AskQuestion")
    expect(JSON.stringify(payload)).not.toContain("[REDACTED]")
    expect(payload.envelope["resolvedProvider"]).toBe("cursor")
    expect(payload.envelope["declaredEvent"]).toBe("preToolUse")
  })

  it("maps row metadata for provider routing without projection drafts", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "beforeMCPExecution",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-mcp-before",
      hookInputParseOk: true,
      hookInput: {
        conversation_id: "conv-mcp",
        hook_event_name: "beforeMCPExecution",
        mcp_server: "plugin-compound-engineering-context7",
        tool_name: "resolve-library-id",
        cursor_version: "1.0.0",
      },
    })

    expect(hookSignalToActivityDrafts(signal)).toEqual([])
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])

    const row = rawHookSignalRowFrom(signal, "2026-06-04T12:00:01.000Z")
    expect(row.resolvedProvider).toBe("cursor")
    expect(row.declaredEvent).toBe("beforeMCPExecution")
    expect(row.nativeHookEventName).toBe("beforeMCPExecution")
    expect(row.targetSessionId).toBe("target_01")
    expect(row.hookInputParseOk).toBe(1)
  })

  it("maps generic preToolUse with no file paths and zero downstream drafts", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "preToolUse",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-ask",
      hookInput: {
        conversation_id: "conv-ask",
        hook_event_name: "preToolUse",
        tool_name: "AskQuestion",
        tool_input: {},
        cursor_version: "1.0.0",
      },
    })

    expect(hookSignalToActivityDrafts(signal)).toEqual([])
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])

    const row = rawHookSignalRowFrom(signal, "2026-06-04T12:00:01.000Z")
    expect(row.declaredEvent).toBe("preToolUse")
    expect(row.nativeToolUseId).toBeNull()
  })

  it("covers afterMCPExecution the same way as beforeMCPExecution", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "afterMCPExecution",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-mcp-after",
      hookInput: {
        conversation_id: "conv-mcp",
        hook_event_name: "afterMCPExecution",
        mcp_server: "plugin-compound-engineering-context7",
        cursor_version: "1.0.0",
      },
    })

    expect(hookSignalToActivityDrafts(signal)).toEqual([])
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])

    const row = rawHookSignalRowFrom(signal, "2026-06-04T12:00:01.000Z")
    expect(row.declaredEvent).toBe("afterMCPExecution")
    expect(row.nativeConversationId).toBe("conv-mcp")
  })
})
