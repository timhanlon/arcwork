import { effectiveCursorEvent } from "./cursor-events.js"
import { hookInputObj, num, str } from "./hook-input.js"
import type { HookSignal } from "./signals.js"

/**
 * The provider-neutral view of one hook signal.
 *
 * Both projectors — the activity stream (`agent-event.ts`) and the chat rows
 * (`chat-message.ts`) — used to switch on each provider's native event names and
 * re-read each provider's field synonyms (`agent_id` ⁄ `subagent_id`,
 * `description` ⁄ `task`, snake ⁄ camel) inline. That spread the same
 * "interpret a hook payload" concern across two parallel `map{Claude,Codex,Cursor}`
 * triplets that even disagreed on which provider a signal was.
 *
 * This module is the single seam that answers those questions once:
 * - the resolved provider (payload shape wins — already decided in `signals.ts`);
 * - one {@link CanonicalEvent} vocabulary every provider maps into;
 * - typed accessors that fold the field-synonym chains into one place.
 *
 * Downstream projectors dispatch on {@link CanonicalEvent} and pull fields through
 * the accessors, so a new provider is one event map plus the synonyms it adds,
 * not an edit in four files.
 */
export type CanonicalEvent =
  | "session_start"
  | "session_end"
  | "turn_start"
  | "turn_end"
  | "compact"
  | "subagent_start"
  | "subagent_stop"
  | "tool_pre"
  | "tool_post"
  | "tool_post_failure"
  | "permission_request"
  | "permission_denied"
  | "permission_resolved"
  | "message_display"
  | "file_edit"
  | "unknown"

/** Claude and Codex share one native event vocabulary. */
const SHARED_EVENTS: Record<string, CanonicalEvent> = {
  SessionStart: "session_start",
  SessionEnd: "session_end",
  UserPromptSubmit: "turn_start",
  Stop: "turn_end",
  PreCompact: "compact",
  PostCompact: "compact",
  SubagentStart: "subagent_start",
  SubagentStop: "subagent_stop",
  PreToolUse: "tool_pre",
  PostToolUse: "tool_post",
  PostToolUseFailure: "tool_post_failure",
  PermissionRequest: "permission_request",
  PermissionDenied: "permission_denied",
  MessageDisplay: "message_display",
}

/** Cursor names the same lifecycle differently (see cursor-events.ts aliases). */
const CURSOR_EVENTS: Record<string, CanonicalEvent> = {
  sessionStart: "session_start",
  sessionEnd: "session_end",
  beforeSubmitPrompt: "turn_start",
  stop: "turn_end",
  preCompact: "compact",
  subagentStart: "subagent_start",
  subagentStop: "subagent_stop",
  preToolUse: "tool_pre",
  postToolUse: "tool_post",
  postToolUseFailure: "tool_post_failure",
  // Cursor gates shell/MCP execution on approval. The `before*` event is the
  // approval prompt (→ permission_request); the matching `after*` event fires
  // once the command has run, i.e. the approval was answered (→ permission_resolved).
  // Unlike Claude/Codex — which emit no "granted" event and rely on the next tool
  // lifecycle event to imply resolution — Cursor's completion is explicit.
  beforeShellExecution: "permission_request",
  beforeMCPExecution: "permission_request",
  afterShellExecution: "permission_resolved",
  afterMCPExecution: "permission_resolved",
  afterAgentResponse: "message_display",
  afterFileEdit: "file_edit",
  afterTabFileEdit: "file_edit",
}

/**
 * Resolve a signal's native event name to the canonical vocabulary. Cursor's
 * native names come through {@link effectiveCursorEvent} (which honours an
 * explicit `hook_event_name` and otherwise de-aliases the Claude-style name a
 * cursor-via-claude-config payload arrives under).
 */
export const canonicalEvent = (signal: HookSignal): CanonicalEvent => {
  if (signal.provider === "cursor") {
    return CURSOR_EVENTS[effectiveCursorEvent(signal)] ?? "unknown"
  }
  return SHARED_EVENTS[signal.declaredEvent] ?? "unknown"
}

// ── Field accessors ─────────────────────────────────────────────────────────
// Each folds the provider/case synonyms for one fact into a single read. Native
// envelope fields (already normalized in signals.ts) win over raw hookInput.

const input = (signal: HookSignal): Record<string, unknown> | null => hookInputObj(signal)

export const prompt = (signal: HookSignal): string | null => str(input(signal)?.["prompt"])

export const toolName = (signal: HookSignal): string | null =>
  str(input(signal)?.["tool_name"] ?? input(signal)?.["toolName"])

export const toolUseId = (signal: HookSignal): string | null =>
  signal.native.toolUseId ?? str(input(signal)?.["tool_use_id"] ?? input(signal)?.["toolUseId"])

export const cwd = (signal: HookSignal): string | null => signal.cwd ?? str(input(signal)?.["cwd"])

export const subagentId = (signal: HookSignal): string | null =>
  str(input(signal)?.["agent_id"] ?? input(signal)?.["subagent_id"])

export const subagentType = (signal: HookSignal): string | null =>
  str(input(signal)?.["agent_type"] ?? input(signal)?.["subagent_type"])

export const taskDescription = (signal: HookSignal): string | null =>
  str(input(signal)?.["description"] ?? input(signal)?.["task"])

export const turnCount = (signal: HookSignal): number | null =>
  num(input(signal)?.["loop_count"] ?? input(signal)?.["loopCount"])

export const contextTokens = (signal: HookSignal): number | null =>
  num(input(signal)?.["context_tokens"] ?? input(signal)?.["contextTokens"])

export const contextWindowSize = (signal: HookSignal): number | null =>
  num(input(signal)?.["context_window_size"] ?? input(signal)?.["contextWindowSize"])

export const durationMs = (signal: HookSignal): number | null =>
  num(input(signal)?.["duration_ms"] ?? input(signal)?.["durationMs"])

export const stringList = (v: unknown): Array<string> =>
  Array.isArray(v) ? v.filter((item): item is string => typeof item === "string" && item.length > 0) : []

export const modifiedFilesList = (signal: HookSignal): Array<string> =>
  stringList(input(signal)?.["modified_files"] ?? input(signal)?.["modifiedFiles"])
