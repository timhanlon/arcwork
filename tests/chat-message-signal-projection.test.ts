import { describe, expect, it } from "vitest"
import {
  chatIdFromSignal,
  isPermissionRequestSignal,
  isPermissionResolutionSignal,
  rawHookSignalFromRow,
} from "../src/main/services/chat-message/signal-projection.js"
import type { HookSignal } from "../src/main/hooks/signals.js"
import { toSignal } from "../src/main/hooks/signals.js"
import type { RawHookSignalRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

const CHAT = "chat_1"
const TARGET = "target_1"
const NOW = "2026-06-11T00:00:00.000Z"

const signal = (body: Record<string, unknown>): HookSignal => {
  const result = toSignal(JSON.stringify({
    arc: { chatId: CHAT, targetSessionId: TARGET, targetProvider: body["declaredProvider"], hookSockPresent: true },
    arcTargetSessionId: TARGET,
    arcChatSessionId: CHAT,
    observedAt: NOW,
    ...body,
  }))
  if (!result.ok) throw new Error(result.reason)
  return result.signal
}

const claude = (event: string, hookInput: Record<string, unknown>, sha = event): HookSignal =>
  signal({ declaredProvider: "claude", declaredEvent: event, hookInputSha256: sha, hookInput })

const cursor = (event: string, hookInput: Record<string, unknown>): HookSignal =>
  signal({
    declaredProvider: "cursor",
    declaredEvent: event,
    hookInputSha256: `cursor-${event}`,
    hookInput: { hook_event_name: event, cursor_version: "2.5", ...hookInput },
  })

describe("chat-message signal projection", () => {
  it("resolves the chat id, preferring the explicit session id over the envelope", () => {
    expect(chatIdFromSignal(claude("Stop", {}))).toBe(CHAT)
  })

  describe("permission request classification", () => {
    it("treats a real Claude tool approval as a request", () => {
      expect(isPermissionRequestSignal(claude("PermissionRequest", { tool_name: "Bash", tool_use_id: "t1" }))).toBe(true)
    })

    it("does not treat Claude AskUserQuestion as an approval gate", () => {
      const ask = claude("PermissionRequest", { tool_name: "AskUserQuestion", tool_use_id: "t1" })
      expect(isPermissionRequestSignal(ask)).toBe(false)
    })

    it("treats a Cursor shell/MCP gate (no tool_name) as a request", () => {
      expect(isPermissionRequestSignal(cursor("beforeShellExecution", { command: "ls" }))).toBe(true)
      expect(isPermissionRequestSignal(cursor("beforeMCPExecution", {}))).toBe(true)
    })

    it("ignores non-permission events", () => {
      expect(isPermissionRequestSignal(claude("PreToolUse", { tool_name: "Bash" }))).toBe(false)
    })
  })

  describe("permission resolution classification", () => {
    it("resolves on the next real tool lifecycle event", () => {
      expect(isPermissionResolutionSignal(claude("PostToolUse", { tool_name: "Bash" }))).toBe(true)
    })

    it("does not resolve on an AskUserQuestion lifecycle event", () => {
      expect(isPermissionResolutionSignal(claude("PostToolUse", { tool_name: "AskUserQuestion" }))).toBe(false)
    })

    it("resolves on Cursor after-execution completion", () => {
      expect(isPermissionResolutionSignal(cursor("afterShellExecution", {}))).toBe(true)
    })

    it("resolves on turn end as a backstop", () => {
      expect(isPermissionResolutionSignal(cursor("stop", {}))).toBe(true)
    })
  })

  describe("rawHookSignalFromRow", () => {
    const baseRow = (over: Partial<RawHookSignalRow>): RawHookSignalRow => ({
      id: arcId("hook", "raw_1"),
      chatId: arcId("chat", CHAT),
      targetSessionId: arcId("target", TARGET),
      targetProvider: "claude",
      resolvedProvider: "claude",
      declaredProvider: "claude",
      declaredEvent: "PostToolUse",
      nativeSessionId: "sess_1",
      nativeConversationId: null,
      nativeTurnId: "turn_1",
      nativeToolUseId: "tool_1",
      nativeHookEventName: "PostToolUse",
      hookInputSha256: "sha_1",
      hookInputParseOk: 1,
      observedAt: NOW,
      receivedAt: NOW,
      payloadJson: JSON.stringify({
        envelope: { schemaVersion: 1, arc: { chatId: CHAT, targetSessionId: TARGET, targetProvider: "claude", hookSockPresent: true } },
        hookInput: { tool_name: "Bash" },
      }),
      ...over,
    })

    it("rebuilds a signal from the persisted envelope", () => {
      const rebuilt = rawHookSignalFromRow(baseRow({}))
      expect(rebuilt?.provider).toBe("claude")
      expect(rebuilt?.arcChatSessionId).toBe(CHAT)
      expect(rebuilt?.arcTargetSessionId).toBe(TARGET)
      expect(rebuilt?.declaredEvent).toBe("PostToolUse")
      expect(chatIdFromSignal(rebuilt!)).toBe(CHAT)
    })

    it("falls back to the row columns when the envelope omits native/arc", () => {
      const rebuilt = rawHookSignalFromRow(baseRow({ payloadJson: JSON.stringify({ hookInput: {} }) }))
      expect(rebuilt?.native.sessionId).toBe("sess_1")
      expect(rebuilt?.native.toolUseId).toBe("tool_1")
      expect(rebuilt?.arcChatSessionId).toBe(CHAT)
    })

    it("returns null on unparseable payload json", () => {
      expect(rawHookSignalFromRow(baseRow({ payloadJson: "{not json" }))).toBeNull()
    })
  })
})
