import type { HookSignal } from "./signals.js"
import { hookInputObj, str } from "./hook-input.js"

const CURSOR_EVENT_ALIASES: Record<string, string> = {
  SessionStart: "sessionStart",
  SessionEnd: "sessionEnd",
  Stop: "stop",
  UserPromptSubmit: "beforeSubmitPrompt",
  PreCompact: "preCompact",
  SubagentStart: "subagentStart",
  SubagentStop: "subagentStop",
  PostToolUse: "postToolUse",
  PreToolUse: "preToolUse",
}

export const effectiveCursorEvent = (signal: HookSignal): string => {
  const input = hookInputObj(signal)
  const fromInput = str(input?.["hook_event_name"])
  if (fromInput) return fromInput
  return CURSOR_EVENT_ALIASES[signal.declaredEvent] ?? signal.declaredEvent
}
