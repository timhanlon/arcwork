import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { resolveProfile } from "../db/paths.js"

/**
 * The contract between a target CLI's hooks and arc's main process.
 *
 * A launched CLI inherits the `ARC_*` env tags (shared/env-tags.ts) plus
 * `ARC_HOOK_SOCK`. Repo-local provider hooks invoke the installed helper
 * (`arc-hook-signal.mjs`), which connects to that unix socket and writes one
 * JSON line containing the hook payload plus inherited Arc tags. When a
 * `SessionStart`-class payload contains a native `session_id`,
 * `HookSignalServer` also binds it to the inherited `ARC_TARGET_SESSION_ID` —
 * filling `TargetSession.nativeSessionId`, Arc-owned session metadata persisted
 * to `.arc/state/` (for resume/debugging/import), not a join key into any other
 * database.
 *
 * Unlike arc-prototype (which appends JSONL to `.arc/runtime/hook-signals.jsonl`
 * and tails it), the channel here is a live socket: main owns the PTY child, so
 * it is always listening while the child runs, and the file transport's
 * survive-while-app-down advantage does not apply. See
 * `.arc/proposals/2026-06-03-arc-electron-hook-signal-binding.md`.
 */

export const ARC_HOOK_SOCK_ENV = "ARC_HOOK_SOCK"
export const RUNTIME_REL_DIR = ".arc/runtime"
export const HELPER_FILENAME = "arc-hook-signal.mjs"
export const HOOK_SIGNAL_SCHEMA_VERSION = 1
export const HOOK_SIGNAL_HELPER_VERSION = 1

export const runtimeDir = (repoRoot: string): string => path.join(repoRoot, RUNTIME_REL_DIR)
export const helperFile = (repoRoot: string): string =>
  path.join(runtimeDir(repoRoot), HELPER_FILENAME)

/**
 * The unix socket lives in the OS temp dir, NOT the repo: a `sun_path` is capped
 * at ~104 bytes on macOS, and a deep repo path + `.arc/runtime/…` blows past it.
 * A short hash of the repo root keeps the name unique per workspace and short.
 * Include the arc profile so `pnpm dev` and `pnpm start` can observe the same
 * workspace at the same time without stealing each other's hook stream.
 */
export const socketPath = (
  repoRoot: string,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  const hash = createHash("sha1").update(repoRoot).digest("hex").slice(0, 12)
  return path.join(os.tmpdir(), `arc-hook-${resolveProfile(env)}-${hash}.sock`)
}

export interface HookSignalNative {
  readonly sessionId: string | null
  readonly transcriptPath: string | null
  readonly conversationId: string | null
  readonly turnId: string | null
  readonly toolUseId: string | null
  readonly hookEventName: string | null
  readonly model: string | null
}

export interface HookSignalArc {
  readonly chatId: string | null
  readonly targetSessionId: string | null
  readonly targetProvider: string | null
  readonly hookSockPresent: boolean
}

/** Versioned wire record from `arc-hook-signal.mjs`. Legacy flat fields remain
 * readable for records written before the envelope upgrade. */
export interface HookSignalWire {
  readonly schemaVersion?: number
  readonly helperVersion?: number
  readonly declaredProvider?: string
  readonly declaredEvent?: string
  readonly observedAt?: string
  readonly pid?: number
  readonly hookInputParseOk?: boolean
  readonly hookInputSha256?: string
  readonly native?: HookSignalNative
  readonly arc?: HookSignalArc
  /** @deprecated legacy flat field — prefer `declaredProvider` */
  readonly provider?: string
  /** @deprecated legacy flat field — prefer `declaredEvent` */
  readonly event?: string
  /** @deprecated legacy flat field — prefer `native.sessionId` */
  readonly sessionId?: string | null
  readonly arcTargetSessionId?: string | null
  readonly arcChatSessionId?: string | null
  readonly arcTargetProvider?: string | null
  readonly at?: string
  readonly cwd?: string
  readonly argv?: ReadonlyArray<string>
  readonly hookInput?: unknown
}

/** A validated binding: both ids present. The product of a usable wire record. */
export interface HookBinding {
  readonly provider: string
  readonly event: string
  readonly targetSessionId: string
  readonly nativeSessionId: string
  readonly transcriptPath: string | null
}

export interface HookSignal {
  readonly schemaVersion: number
  readonly helperVersion: number
  readonly declaredProvider: string
  readonly declaredEvent: string
  readonly observedAt: string
  readonly cwd: string | null
  readonly pid: number | null
  readonly argv: ReadonlyArray<string>
  readonly hookInput: unknown
  readonly hookInputParseOk: boolean
  readonly hookInputSha256: string
  readonly native: HookSignalNative
  readonly arc: HookSignalArc
  /** Resolved provider (payload shape wins over argv). */
  readonly provider: string
  /** Same as `declaredEvent` for binding compatibility. */
  readonly event: string
  readonly sessionId: string | null
  readonly arcTargetSessionId: string | null
  readonly arcChatSessionId: string | null
  readonly arcTargetProvider: string | null
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const bool = (v: unknown): boolean => v === true

const hookInputRecord = (parsed: Record<string, unknown>): Record<string, unknown> | null =>
  isRecord(parsed["hookInput"]) ? (parsed["hookInput"] as Record<string, unknown>) : null

const firstStr = (obj: Record<string, unknown> | null, keys: ReadonlyArray<string>): string | null => {
  if (!obj) return null
  for (const key of keys) {
    const v = str(obj[key])
    if (v) return v
  }
  return null
}

export const transcriptPathFrom = (hookInput: Record<string, unknown> | null): string | null =>
  firstStr(hookInput, ["transcript_path", "transcriptPath"])

export const sessionIdFrom = (hookInput: Record<string, unknown> | null): string | null =>
  firstStr(hookInput, ["session_id", "sessionId", "sessionID"])

export const conversationIdFrom = (hookInput: Record<string, unknown> | null): string | null =>
  firstStr(hookInput, ["conversation_id", "conversationId"])

const CURSOR_HOOK_EVENT_NAMES = new Set([
  "preToolUse",
  "postToolUse",
  "postToolUseFailure",
  "beforeSubmitPrompt",
  "beforeShellExecution",
  "afterShellExecution",
  "beforeMCPExecution",
  "afterMCPExecution",
  "beforeReadFile",
  "afterFileEdit",
  "beforeTabFileRead",
  "afterTabFileEdit",
  "sessionStart",
  "sessionEnd",
  "preCompact",
  "stop",
  "afterAgentResponse",
  "afterAgentThought",
  "subagentStart",
  "subagentStop",
  "workspaceOpen",
])

/** Cursor-shaped stdin (see cursor.com/docs/reference/third-party-hooks). */
export const isCursorHookPayload = (hookInput: unknown): boolean => {
  if (!isRecord(hookInput)) return false
  if (hookInput["cursor_version"] !== undefined) return true
  const transcriptPath = str(hookInput["transcript_path"]) ?? str(hookInput["transcriptPath"])
  if (transcriptPath?.includes("/.cursor/")) return true
  const hookEventName = str(hookInput["hook_event_name"])
  return hookEventName !== null && CURSOR_HOOK_EVENT_NAMES.has(hookEventName)
}

export const isClaudeHookPayload = (hookInput: unknown): boolean => {
  if (!isRecord(hookInput)) return false
  if (hookInput["permission_mode"] !== undefined) return true
  const transcriptPath = str(hookInput["transcript_path"]) ?? str(hookInput["transcriptPath"])
  if (transcriptPath?.includes("/.claude/")) return true
  return false
}

export const resolveProvider = (
  declaredProvider: string | null,
  hookInput: Record<string, unknown> | null,
): string => {
  // The on-disk transcript path is the strongest discriminator and must win
  // over field-shape heuristics: codex mirrors Claude's hook schema (it emits
  // `permission_mode`, `source`, `hook_event_name`), so a codex payload living
  // under /.codex/ would otherwise be misread as claude by isClaudeHookPayload
  // — dropping its native-session binding and breaking `codex resume`.
  const transcriptPath = transcriptPathFrom(hookInput)
  if (transcriptPath?.includes("/.codex/")) return "codex"
  if (transcriptPath?.includes("/.claude/")) return "claude"
  if (transcriptPath?.includes("/.cursor/")) return "cursor"
  if (isCursorHookPayload(hookInput)) return "cursor"
  if (isClaudeHookPayload(hookInput)) return "claude"
  if (hookInput && (hookInput["model"] !== undefined || hookInput["turn_id"] !== undefined)) return "codex"
  if (hookInput && hookInput["permission_mode"] !== undefined) return "claude"
  if (hookInput && hookInput["cursor_version"] !== undefined) return "cursor"
  return declaredProvider ?? "unknown"
}

const nativeFrom = (
  parsed: Record<string, unknown>,
  hookInput: Record<string, unknown> | null,
): HookSignalNative => {
  const wireNative = isRecord(parsed["native"]) ? parsed["native"] : null
  return {
    sessionId:
      str(wireNative?.["sessionId"]) ??
      str(parsed["sessionId"]) ??
      sessionIdFrom(hookInput) ??
      conversationIdFrom(hookInput),
    transcriptPath:
      str(wireNative?.["transcriptPath"]) ?? transcriptPathFrom(hookInput),
    conversationId: str(wireNative?.["conversationId"]) ?? conversationIdFrom(hookInput),
    turnId: str(wireNative?.["turnId"]) ?? firstStr(hookInput, ["turn_id", "turnId"]),
    toolUseId: str(wireNative?.["toolUseId"]) ?? firstStr(hookInput, ["tool_use_id", "toolUseId"]),
    hookEventName:
      str(wireNative?.["hookEventName"]) ?? firstStr(hookInput, ["hook_event_name", "hookEventName"]),
    model: str(wireNative?.["model"]) ?? str(hookInput?.["model"] ?? null),
  }
}

const arcFrom = (parsed: Record<string, unknown>): HookSignalArc => {
  const wireArc = isRecord(parsed["arc"]) ? parsed["arc"] : null
  return {
    chatId: str(wireArc?.["chatId"]) ?? str(parsed["arcChatSessionId"]),
    targetSessionId: str(wireArc?.["targetSessionId"]) ?? str(parsed["arcTargetSessionId"]),
    targetProvider: str(wireArc?.["targetProvider"]) ?? str(parsed["arcTargetProvider"]),
    hookSockPresent: bool(wireArc?.["hookSockPresent"]),
  }
}

const sha256Hex = (raw: string): string => createHash("sha256").update(raw).digest("hex")

const parseWireLine = (
  line: string,
): { ok: true; parsed: Record<string, unknown> } | { ok: false; reason: string } => {
  const trimmed = line.trim()
  if (!trimmed) return { ok: false, reason: "empty line" }
  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { ok: false, reason: `non-JSON line: ${trimmed.slice(0, 80)}` }
  }
  if (!isRecord(parsed)) return { ok: false, reason: "not an object" }
  return { ok: true, parsed }
}

export const toSignal = (
  line: string,
): { ok: true; signal: HookSignal } | { ok: false; reason: string } => {
  const wire = parseWireLine(line)
  if (!wire.ok) return wire
  const parsed = wire.parsed
  const hookInput = parsed["hookInput"] ?? null
  const hookInputObj = isRecord(hookInput) ? hookInput : null
  const declaredProvider = str(parsed["declaredProvider"]) ?? str(parsed["provider"]) ?? "unknown"
  const declaredEvent = str(parsed["declaredEvent"]) ?? str(parsed["event"]) ?? "unknown"
  const provider = resolveProvider(declaredProvider, hookInputObj)
  const argv = Array.isArray(parsed["argv"])
    ? parsed["argv"].filter((v): v is string => typeof v === "string")
    : []
  const native = nativeFrom(parsed, hookInputObj)
  const arc = arcFrom(parsed)
  const hookInputSha256 =
    str(parsed["hookInputSha256"]) ??
    sha256Hex(typeof hookInput === "string" ? hookInput : JSON.stringify(hookInput ?? ""))
  return {
    ok: true,
    signal: {
      schemaVersion: typeof parsed["schemaVersion"] === "number" ? parsed["schemaVersion"] : 0,
      helperVersion: typeof parsed["helperVersion"] === "number" ? parsed["helperVersion"] : 0,
      declaredProvider,
      declaredEvent,
      observedAt: str(parsed["observedAt"]) ?? str(parsed["at"]) ?? new Date().toISOString(),
      cwd: str(parsed["cwd"]),
      pid: typeof parsed["pid"] === "number" ? parsed["pid"] : null,
      argv,
      hookInput,
      hookInputParseOk: bool(parsed["hookInputParseOk"]),
      hookInputSha256,
      native,
      arc,
      provider,
      event: declaredEvent,
      sessionId: native.sessionId,
      arcTargetSessionId: arc.targetSessionId,
      arcChatSessionId: arc.chatId,
      arcTargetProvider: arc.targetProvider,
    },
  }
}

/**
 * Parse + validate one received line into a binding. Returns a discriminated
 * result so the server can log *why* a record was dropped (Codex tightening #3:
 * defensively validate before mutating session state).
 */
export const toBinding = (
  line: string,
): { ok: true; binding: HookBinding } | { ok: false; reason: string } => {
  const signal = toSignal(line)
  if (!signal.ok) return signal
  const { provider, event, sessionId, arcTargetSessionId, arcTargetProvider, native } =
    signal.signal
  if (!sessionId) return { ok: false, reason: "missing native session_id" }
  if (!arcTargetSessionId) return { ok: false, reason: "missing arcTargetSessionId" }
  if (arcTargetProvider && provider !== arcTargetProvider) {
    return {
      ok: false,
      reason: `provider mismatch: payload=${provider} target=${arcTargetProvider}`,
    }
  }
  return {
    ok: true,
    binding: {
      provider,
      event: event ?? "unknown",
      targetSessionId: arcTargetSessionId,
      nativeSessionId: sessionId,
      transcriptPath: native.transcriptPath,
    },
  }
}
