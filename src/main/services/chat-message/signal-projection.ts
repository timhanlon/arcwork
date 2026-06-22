/**
 * Hook-signal decoding/classification used by ChatMessageService: rebuilding a
 * {@link HookSignal} from its persisted {@link RawHookSignalRow} (the reproject
 * path replays stored signals), resolving the chat a signal belongs to, and the
 * two permission-lifecycle predicates that drive the in-memory
 * `waiting_for_approval` flag. Pure — no stores.
 */
import type { HookSignal } from "../../hooks/signals.js"
import type { RawHookSignalRow } from "../../db/schema.js"
import type { ChatId } from "../../../shared/ids.js"
import * as canon from "../../hooks/canonical.js"
import { isTurnEnd } from "../../hooks/turn-lifecycle.js"

export const chatIdFromSignal = (signal: HookSignal): ChatId | null =>
  signal.arcChatSessionId ?? signal.arc.chatId ?? null

export const rawHookSignalFromRow = (row: RawHookSignalRow): HookSignal | null => {
  let payload: unknown
  try {
    payload = JSON.parse(row.payloadJson)
  } catch {
    return null
  }
  const payloadRecord = payload && typeof payload === "object" && !Array.isArray(payload)
    ? payload as Record<string, unknown>
    : {}
  const envelope = payloadRecord["envelope"] && typeof payloadRecord["envelope"] === "object" &&
      !Array.isArray(payloadRecord["envelope"])
    ? payloadRecord["envelope"] as Record<string, unknown>
    : {}
  const native = envelope["native"] && typeof envelope["native"] === "object" && !Array.isArray(envelope["native"])
    ? envelope["native"] as HookSignal["native"]
    : {
        sessionId: row.nativeSessionId,
        transcriptPath: null,
        conversationId: row.nativeConversationId,
        turnId: row.nativeTurnId,
        toolUseId: row.nativeToolUseId,
        hookEventName: row.nativeHookEventName,
        model: null,
      }
  const arc = envelope["arc"] && typeof envelope["arc"] === "object" && !Array.isArray(envelope["arc"])
    ? envelope["arc"] as HookSignal["arc"]
    : {
        chatId: row.chatId,
        targetSessionId: row.targetSessionId,
        targetProvider: row.targetProvider,
        hookSockPresent: false,
      }
  const provider = row.resolvedProvider
  return {
    schemaVersion: typeof envelope["schemaVersion"] === "number" ? envelope["schemaVersion"] : 0,
    helperVersion: typeof envelope["helperVersion"] === "number" ? envelope["helperVersion"] : 0,
    declaredProvider: row.declaredProvider,
    declaredEvent: row.declaredEvent,
    observedAt: row.observedAt,
    cwd: typeof envelope["cwd"] === "string" ? envelope["cwd"] : null,
    pid: typeof envelope["pid"] === "number" ? envelope["pid"] : null,
    argv: Array.isArray(envelope["argv"])
      ? envelope["argv"].filter((v): v is string => typeof v === "string")
      : [],
    hookInput: payloadRecord["hookInput"] ?? null,
    hookInputParseOk: row.hookInputParseOk === 1,
    hookInputSha256: row.hookInputSha256,
    native,
    arc,
    provider,
    event: row.declaredEvent,
    sessionId: native.sessionId,
    arcTargetSessionId: arc.targetSessionId,
    arcChatSessionId: arc.chatId,
    arcTargetProvider: arc.targetProvider,
  }
}

// Both predicates route off the canonical event so each provider's native names
// (Claude/Codex `PermissionRequest`, Cursor `beforeShellExecution` /
// `beforeMCPExecution`) resolve in one place — `canonical.ts` — rather than this
// service re-listing them. They drive the in-memory `waiting_for_approval` flag.
export const isPermissionRequestSignal = (signal: HookSignal): boolean => {
  if (canon.canonicalEvent(signal) !== "permission_request") return false
  // Claude/Codex also route AskUserQuestion through PermissionRequest, but that's
  // a question row (drafted elsewhere), not an approval gate. Their real approvals
  // always name a tool; Cursor's shell/MCP approval carries no tool_name, so the
  // tool guard only applies off-cursor.
  if (signal.provider === "cursor") return true
  return canon.toolName(signal) !== "AskUserQuestion" && !!canon.toolName(signal)
}

export const isPermissionResolutionSignal = (signal: HookSignal): boolean => {
  const event = canon.canonicalEvent(signal)
  // Explicit resolutions: a denial, Cursor's after-shell/after-MCP completion, or
  // the turn ending (a backstop so an approval can never outlive its turn — e.g. a
  // Cursor denial that fires no `after*` event still clears on `stop`).
  if (event === "permission_denied" || event === "permission_resolved") return true
  if (isTurnEnd(signal)) return true
  // Claude/Codex emit no "granted" event; the next lifecycle event for a real
  // (non-question) tool means the pending approval was answered.
  if (event !== "tool_pre" && event !== "tool_post" && event !== "tool_post_failure") return false
  const toolName = canon.toolName(signal)
  return !!toolName && toolName !== "AskUserQuestion"
}
