import type { HookSignal } from "./signals.js"
import type { RawHookSignalRow } from "../db/schema.js"
import { newArcId } from "../../shared/ids.js"

/** Unredacted hook input plus the full versioned helper envelope for debugging. */
export const rawHookSignalPayloadJson = (signal: HookSignal): string =>
  JSON.stringify({
    envelope: {
      schemaVersion: signal.schemaVersion,
      helperVersion: signal.helperVersion,
      declaredProvider: signal.declaredProvider,
      declaredEvent: signal.declaredEvent,
      observedAt: signal.observedAt,
      cwd: signal.cwd,
      pid: signal.pid,
      argv: signal.argv,
      hookInputSha256: signal.hookInputSha256,
      hookInputParseOk: signal.hookInputParseOk,
      native: signal.native,
      arc: signal.arc,
      resolvedProvider: signal.provider,
    },
    hookInput: signal.hookInput,
  })

export const rawHookSignalRowFrom = (
  signal: HookSignal,
  receivedAt: string,
): RawHookSignalRow => ({
  id: newArcId("hook"),
  chatId: signal.arcChatSessionId ?? signal.arc.chatId,
  targetSessionId: signal.arcTargetSessionId ?? signal.arc.targetSessionId,
  targetProvider: signal.arcTargetProvider ?? signal.arc.targetProvider,
  resolvedProvider: signal.provider,
  declaredProvider: signal.declaredProvider,
  declaredEvent: signal.declaredEvent,
  nativeSessionId: signal.native.sessionId,
  nativeConversationId: signal.native.conversationId,
  nativeTurnId: signal.native.turnId,
  nativeToolUseId: signal.native.toolUseId,
  nativeHookEventName: signal.native.hookEventName,
  hookInputSha256: signal.hookInputSha256,
  hookInputParseOk: signal.hookInputParseOk ? 1 : 0,
  observedAt: signal.observedAt,
  receivedAt,
  payloadJson: rawHookSignalPayloadJson(signal),
})
