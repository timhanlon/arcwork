import { createHash } from "node:crypto"
import * as canon from "./canonical.js"
import type { HookSignal } from "./signals.js"
import { isRecord, resolveProvider, sessionIdFrom, transcriptPathFrom } from "./signals.js"

export type AgentEventType =
  | "session_start"
  | "turn_start"
  | "turn_end"
  | "compaction"
  | "session_end"
  | "subagent_start"
  | "subagent_end"
  | "model_update"
  | "tool_use"

export type ActivityKind =
  | "target.session.started"
  | "target.session.ended"
  | "target.turn.started"
  | "target.turn.ended"
  | "target.state.changed"
  | "target.context.compacted"
  | "target.model.updated"
  | "target.tool.used"
  | "target.subagent.started"
  | "target.subagent.ended"
  | "file.observed"

export interface AgentEvent {
  readonly type: AgentEventType
  readonly provider: string
  readonly declaredProvider: string
  readonly declaredEvent: string
  readonly sessionId: string | null
  readonly sessionRef: string | null
  readonly prompt: string | null
  readonly model: string | null
  readonly toolUseId: string | null
  readonly subagentId: string | null
  readonly subagentType: string | null
  readonly taskDescription: string | null
  readonly modifiedFiles: ReadonlyArray<string>
  readonly newFiles: ReadonlyArray<string>
  readonly deletedFiles: ReadonlyArray<string>
  readonly cwd: string | null
  readonly turnCount: number | null
  readonly contextTokens: number | null
  readonly contextWindowSize: number | null
  readonly durationMs: number | null
  readonly occurredAt: string
  readonly hookInputSha256: string
  readonly secondary: boolean
}

export interface ActivityEventDraft {
  readonly kind: ActivityKind
  readonly dedupKey: string
  readonly payload: Record<string, unknown>
  readonly provenance: Record<string, unknown>
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

const hookInputObj = (signal: HookSignal): Record<string, unknown> | null =>
  isRecord(signal.hookInput) ? signal.hookInput : null

const nativeSessionId = (signal: HookSignal): string | null =>
  signal.native.sessionId ??
  signal.native.conversationId ??
  sessionIdFrom(hookInputObj(signal))

const AGENT_TO_ACTIVITY: Record<AgentEventType, ActivityKind> = {
  session_start: "target.session.started",
  turn_start: "target.turn.started",
  turn_end: "target.turn.ended",
  compaction: "target.context.compacted",
  session_end: "target.session.ended",
  subagent_start: "target.subagent.started",
  subagent_end: "target.subagent.ended",
  model_update: "target.model.updated",
  tool_use: "target.tool.used",
}

const applyPatchFileRegex = /\*\*\* (Add|Update|Delete) File: (.+)/
const applyPatchMoveRegex = /\*\*\* Move to: (.+)/

export const classifyApplyPatchPaths = (
  input: string,
): { newFiles: Array<string>; modifiedFiles: Array<string>; deletedFiles: Array<string> } => {
  const bucket = new Map<string, string>()
  let lastUpdate = ""
  for (const line of input.split("\n")) {
    const fileMatch = applyPatchFileRegex.exec(line)
    if (fileMatch) {
      const verb = fileMatch[1] ?? ""
      const filePath = (fileMatch[2] ?? "").trim()
      if (!filePath) continue
      if (verb === "Update") lastUpdate = filePath
      else lastUpdate = ""
      const existing = bucket.get(filePath)
      if (existing === "Add" || existing === "Delete") continue
      bucket.set(filePath, verb)
      continue
    }
    const moveMatch = applyPatchMoveRegex.exec(line)
    if (moveMatch) {
      const target = (moveMatch[1] ?? "").trim()
      if (!target) continue
      if (lastUpdate) {
        const existing = bucket.get(lastUpdate)
        if (!existing || (existing !== "Add" && existing !== "Delete")) {
          bucket.set(lastUpdate, "Delete")
        }
      }
      const existingTarget = bucket.get(target)
      if (!existingTarget || (existingTarget !== "Add" && existingTarget !== "Delete")) {
        bucket.set(target, "Add")
      }
      lastUpdate = ""
    }
  }
  const newFiles: Array<string> = []
  const modifiedFiles: Array<string> = []
  const deletedFiles: Array<string> = []
  for (const [filePath, verb] of bucket) {
    if (verb === "Add") newFiles.push(filePath)
    else if (verb === "Update") modifiedFiles.push(filePath)
    else if (verb === "Delete") deletedFiles.push(filePath)
  }
  newFiles.sort()
  modifiedFiles.sort()
  deletedFiles.sort()
  return { newFiles, modifiedFiles, deletedFiles }
}

const isApplyPatchTool = (name: string | null): boolean =>
  name === "apply_patch" || name === "Write" || name === "Edit"

const baseEvent = (signal: HookSignal, type: AgentEventType, secondary: boolean): AgentEvent => {
  const input = hookInputObj(signal)
  return {
    type,
    provider: signal.provider,
    declaredProvider: signal.declaredProvider,
    declaredEvent: signal.declaredEvent,
    sessionId: nativeSessionId(signal),
    sessionRef: signal.native.transcriptPath ?? transcriptPathFrom(input),
    prompt: canon.prompt(signal),
    model: signal.native.model,
    toolUseId: signal.native.toolUseId,
    subagentId: null,
    subagentType: null,
    taskDescription: null,
    modifiedFiles: [],
    newFiles: [],
    deletedFiles: [],
    cwd: canon.cwd(signal),
    turnCount: canon.turnCount(signal),
    contextTokens: canon.contextTokens(signal),
    contextWindowSize: canon.contextWindowSize(signal),
    durationMs: canon.durationMs(signal),
    occurredAt: signal.observedAt,
    hookInputSha256: signal.hookInputSha256,
    secondary,
  }
}

const isSecondaryDuplicate = (signal: HookSignal): boolean =>
  signal.provider === "cursor" &&
  signal.declaredProvider.toLowerCase() === "claude" &&
  resolveProvider(signal.declaredProvider, hookInputObj(signal)) === "cursor"

/**
 * One dispatcher over the canonical event vocabulary, replacing the former
 * `map{Claude,Codex,Cursor}` triplet. Provider routing is now resolved once (via
 * `signal.provider` inside `canonicalEvent`), so the three providers no longer
 * disagree on which signal they're handling, and the field-synonym chains are
 * folded into the `canon.*` accessors. The few genuinely provider-specific quirks
 * that survive are explicit single-line guards, not whole parallel functions.
 */
export const hookSignalToAgentEvents = (signal: HookSignal): ReadonlyArray<AgentEvent> => {
  const secondary = isSecondaryDuplicate(signal)
  const make = (type: AgentEventType): AgentEvent => baseEvent(signal, type, secondary)
  switch (canon.canonicalEvent(signal)) {
    case "session_start": {
      const events: Array<AgentEvent> = [make("session_start")]
      if (signal.native.model) events.push({ ...make("model_update"), model: signal.native.model })
      return events
    }
    case "turn_start":
      return [make("turn_start")]
    case "turn_end":
      return [make("turn_end")]
    case "session_end":
      return [make("session_end")]
    case "compact":
      return [make("compaction")]
    case "subagent_start": {
      // Cursor fires subagent hooks for non-subagent work; a task description is
      // its signal that this is a real subagent. Claude/Codex carry no such noise.
      if (signal.provider === "cursor" && !canon.taskDescription(signal)) return []
      return [
        {
          ...make("subagent_start"),
          toolUseId: canon.toolUseId(signal) ?? canon.subagentId(signal),
          subagentId: canon.subagentId(signal),
          subagentType: canon.subagentType(signal),
          taskDescription: canon.taskDescription(signal),
        },
      ]
    }
    case "subagent_stop": {
      if (signal.provider === "cursor" && !canon.taskDescription(signal)) return []
      return [
        {
          ...make("subagent_end"),
          toolUseId: canon.toolUseId(signal) ?? canon.subagentId(signal),
          subagentId: canon.subagentId(signal),
          subagentType: canon.subagentType(signal),
          taskDescription: canon.taskDescription(signal),
          modifiedFiles: canon.modifiedFilesList(signal),
        },
      ]
    }
    case "tool_post": {
      // Only Codex reports file changes through PostToolUse (apply_patch / Write /
      // Edit). Claude's edits land via the transcript and Cursor's via file_edit,
      // so they intentionally produce nothing on this branch.
      if (signal.provider !== "codex" || !isApplyPatchTool(canon.toolName(signal))) return []
      const toolInput = hookInputObj(signal)?.["tool_input"]
      const command =
        isRecord(toolInput) && typeof toolInput["command"] === "string" ? toolInput["command"] : ""
      const files = classifyApplyPatchPaths(command)
      if (files.newFiles.length + files.modifiedFiles.length + files.deletedFiles.length === 0) {
        return []
      }
      return [
        {
          ...make("tool_use"),
          toolUseId: canon.toolUseId(signal),
          cwd: canon.cwd(signal),
          newFiles: files.newFiles,
          modifiedFiles: files.modifiedFiles,
          deletedFiles: files.deletedFiles,
        },
      ]
    }
    case "file_edit": {
      const input = hookInputObj(signal)
      const filePath = str(input?.["file_path"] ?? input?.["filePath"])
      if (!filePath) return []
      return [{ ...make("tool_use"), modifiedFiles: [filePath] }]
    }
    default:
      return []
  }
}

export const agentEventDedupKey = (event: AgentEvent): string =>
  createHash("sha256")
    .update(
      [
        event.provider,
        event.type,
        event.sessionId ?? "",
        event.toolUseId ?? "",
        event.subagentId ?? "",
        event.hookInputSha256,
      ].join("\u0000"),
    )
    .digest("hex")

const USAGE_TOKEN_KEY =
  /^(input_tokens|output_tokens|cache_read_tokens|cache_write_tokens|cache_creation_tokens|cached_input_tokens|reasoning_output_tokens|total_tokens)$/i
const SENSITIVE_KEY = /(api[_-]?key|token|password|secret|authorization)/i
const SENSITIVE_VALUE =
  /\b(sk-[a-zA-Z0-9]{20,}|ghp_[a-zA-Z0-9]{36,}|github_pat_[a-zA-Z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[baprs]-[a-zA-Z0-9-]{10,})\b/g

export const redactValue = (value: unknown): unknown => {
  if (typeof value === "string") return value.replace(SENSITIVE_VALUE, "[REDACTED]")
  if (Array.isArray(value)) return value.map(redactValue)
  if (!isRecord(value)) return value
  const out: Record<string, unknown> = {}
  for (const [key, child] of Object.entries(value)) {
    if (USAGE_TOKEN_KEY.test(key)) out[key] = redactValue(child)
    else if (SENSITIVE_KEY.test(key)) out[key] = "[REDACTED]"
    else out[key] = redactValue(child)
  }
  return out
}

const agentPayload = (event: AgentEvent): Record<string, unknown> => ({
  agentEventType: event.type,
  provider: event.provider,
  declaredProvider: event.declaredProvider,
  declaredEvent: event.declaredEvent,
  sessionId: event.sessionId,
  sessionRef: event.sessionRef,
  prompt: event.prompt,
  model: event.model,
  toolUseId: event.toolUseId,
  subagentId: event.subagentId,
  subagentType: event.subagentType,
  taskDescription: event.taskDescription,
  modifiedFiles: event.modifiedFiles,
  newFiles: event.newFiles,
  deletedFiles: event.deletedFiles,
  cwd: event.cwd,
  turnCount: event.turnCount,
  contextTokens: event.contextTokens,
  contextWindowSize: event.contextWindowSize,
  durationMs: event.durationMs,
  secondary: event.secondary,
})

const provenanceFrom = (signal: HookSignal, event: AgentEvent): Record<string, unknown> => ({
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
  hookInput: redactValue(signal.hookInput),
  native: signal.native,
  arc: signal.arc,
  resolvedProvider: signal.provider,
  secondary: event.secondary,
})

export const agentEventToActivityDrafts = (
  signal: HookSignal,
  event: AgentEvent,
): ReadonlyArray<ActivityEventDraft> => {
  // Forwarded hook payloads are useful provenance, but they must not become the
  // canonical product stream. The primary provider hook writes the real
  // activity event; otherwise timelines mix config ownership with payload
  // ownership, notably Cursor payloads delivered through Claude hook config.
  if (event.secondary) return []

  const baseKey = agentEventDedupKey(event)
  const drafts: Array<ActivityEventDraft> = [
    {
      kind: AGENT_TO_ACTIVITY[event.type],
      dedupKey: baseKey,
      payload: agentPayload(event),
      provenance: provenanceFrom(signal, event),
    },
  ]

  if (event.type === "tool_use" || event.type === "subagent_end") {
    const paths: Array<{ path: string; changeKind: string }> = [
      ...event.newFiles.map((p) => ({ path: p, changeKind: "added" })),
      ...event.modifiedFiles.map((p) => ({ path: p, changeKind: "modified" })),
      ...event.deletedFiles.map((p) => ({ path: p, changeKind: "deleted" })),
    ]
    for (const file of paths) {
      drafts.push({
        kind: "file.observed",
        dedupKey: createHash("sha256")
          .update(`${baseKey}\u0000file\u0000${file.path}\u0000${file.changeKind}`)
          .digest("hex"),
        payload: {
          path: file.path,
          changeKind: file.changeKind,
          provider: event.provider,
          sessionId: event.sessionId,
          toolUseId: event.toolUseId,
          subagentId: event.subagentId,
        },
        provenance: provenanceFrom(signal, event),
      })
    }
  }

  return drafts
}

export const hookSignalToActivityDrafts = (signal: HookSignal): ReadonlyArray<ActivityEventDraft> =>
  hookSignalToAgentEvents(signal).flatMap((event) => agentEventToActivityDrafts(signal, event))
