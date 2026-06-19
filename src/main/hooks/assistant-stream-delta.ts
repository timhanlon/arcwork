import type { AssistantStreamDelta } from "../../shared/assistant-stream.js"
import { hookInputObj, str } from "./hook-input.js"
import type { HookSignal } from "./signals.js"

/** A Claude MessageDisplay → ephemeral live delta, or null for anything else. */
export const hookSignalToAssistantStreamDelta = (signal: HookSignal): AssistantStreamDelta | null => {
  if (signal.provider !== "claude" || signal.declaredEvent !== "MessageDisplay") return null
  const input = hookInputObj(signal)
  const delta = str(input?.["delta"]) ?? ""
  const final = input?.["final"] === true
  if (!delta && !final) return null
  return {
    chatId: signal.arcChatSessionId ?? signal.arc.chatId ?? null,
    targetSessionId: signal.arcTargetSessionId ?? null,
    messageId: str(input?.["message_id"] ?? input?.["messageId"]),
    delta,
    final,
    model: signal.native.model,
  }
}
