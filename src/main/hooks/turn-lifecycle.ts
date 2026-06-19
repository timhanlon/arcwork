import type { HookSignal } from "./signals.js"

/**
 * The turn lifecycle read off a hook signal — the only "is a turn actually open"
 * source arc has. A turn opens when the user's prompt is submitted and closes
 * when the provider ends the top-level turn. This feeds the `generating` live
 * activity (see shared/live-target-state.ts); it is intentionally separate from
 * the durable transcript projection.
 */

/**
 * The user submitted a prompt — a top-level turn is now open. Claude/Codex emit
 * `UserPromptSubmit`; Cursor emits `beforeSubmitPrompt`.
 */
export const isTurnStart = (signal: HookSignal): boolean => {
  const event = signal.declaredEvent.toLowerCase()
  return event === "userpromptsubmit" || event === "beforesubmitprompt"
}

/**
 * The top-level assistant turn ended (Claude/Codex "Stop", Cursor "stop").
 * Deliberately excludes "SubagentStop": a subagent finishing does not end the
 * parent turn — the agent may still be generating — so it must not flip the
 * session back to idle.
 */
export const isTurnEnd = (signal: HookSignal): boolean =>
  signal.declaredEvent.toLowerCase() === "stop"

/**
 * Collapse a signal to its turn transition, or `null` when it carries none. A
 * session ending also closes any open turn (the child is gone).
 */
export const turnLifecycle = (signal: HookSignal): "open" | "close" | null => {
  if (isTurnStart(signal)) return "open"
  if (isTurnEnd(signal)) return "close"
  const event = signal.declaredEvent.toLowerCase()
  if (event === "sessionend" || event === "session_end") return "close"
  return null
}
