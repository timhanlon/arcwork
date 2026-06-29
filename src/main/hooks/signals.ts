import { createHash } from "node:crypto"
import * as os from "node:os"
import * as path from "node:path"
import { Data, Result, Schema } from "effect"
import { arcIdOrNull, ChatId, TargetId } from "../../shared/ids.js"
import { arcWorkRuntimeDir, resolveProfile } from "../db/paths.js"

/**
 * The contract between a target CLI's hooks and arc's main process.
 *
 * A launched CLI inherits the `ARC_*` env tags (shared/env-tags.ts) plus
 * `ARC_HOOK_SOCK` (the socket to write to) and `ARC_HOOK_HELPER` (the absolute
 * path of the helper to invoke). Provider hooks invoke that Arc-owned helper
 * (`arc-hook-signal.mjs`), which connects to the socket and writes one JSON line
 * containing the hook payload plus inherited Arc tags. When a
 * `SessionStart`-class payload contains a native `session_id`,
 * `HookSignalServer` also binds it to the inherited `ARC_TARGET_SESSION_ID` —
 * filling `TargetSession.nativeSessionId`, Arc-owned session metadata persisted
 * to `.arc/state/` (for resume/debugging/import), not a join key into any other
 * database.
 *
 * The helper is Arc-owned and lives outside any target repo
 * (`~/.arcwork/<profile>/runtime/`, see {@link arcOwnedHelperFile}): one copy
 * per profile rather than a generated executable written into each workspace,
 * so a repo Arc opens stays clean. Provider hook config and `ARC_HOOK_HELPER`
 * both point at that single path.
 *
 * Unlike arc-prototype (which appends JSONL to `.arc/runtime/hook-signals.jsonl`
 * and tails it), the channel here is a live socket: main owns the PTY child, so
 * it is always listening while the child runs, and the file transport's
 * survive-while-app-down advantage does not apply. See
 * `.arc/proposals/2026-06-03-arcwork-hook-signal-binding.md`.
 */

export const ARC_HOOK_SOCK_ENV = "ARC_HOOK_SOCK"
export const ARC_HOOK_HELPER_ENV = "ARC_HOOK_HELPER"
export const HELPER_FILENAME = "arc-hook-signal.mjs"
export const HOOK_SIGNAL_SCHEMA_VERSION = 1
export const HOOK_SIGNAL_HELPER_VERSION = 4

/**
 * Absolute path of the Arc-owned hook helper for the current profile. Stable
 * across every workspace, so it can be both written once and referenced from
 * provider hook config / `ARC_HOOK_HELPER` without touching any repo.
 */
export const arcOwnedHelperFile = (env: NodeJS.ProcessEnv = process.env): string =>
  path.join(arcWorkRuntimeDir(resolveProfile(env)), HELPER_FILENAME)

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

export const HookSignalNative = Schema.Struct({
  sessionId: Schema.NullOr(Schema.String),
  transcriptPath: Schema.NullOr(Schema.String),
  conversationId: Schema.NullOr(Schema.String),
  turnId: Schema.NullOr(Schema.String),
  toolUseId: Schema.NullOr(Schema.String),
  hookEventName: Schema.NullOr(Schema.String),
  model: Schema.NullOr(Schema.String),
})
export type HookSignalNative = typeof HookSignalNative.Type

export const HookSignalArc = Schema.Struct({
  chatId: Schema.NullOr(ChatId),
  targetSessionId: Schema.NullOr(TargetId),
  targetProvider: Schema.NullOr(Schema.String),
  hookSockPresent: Schema.Boolean,
})
export type HookSignalArc = typeof HookSignalArc.Type

/** The serialized `native`/`arc` sub-records as they ride the wire and sit in
 * `raw_hook_signals.payloadJson`: every field optional so an older or partial
 * record still decodes. Branding/normalization happens when the envelope is
 * lifted into a {@link HookSignal}. */
const WireNative = Schema.Struct({
  sessionId: Schema.optional(Schema.NullOr(Schema.String)),
  transcriptPath: Schema.optional(Schema.NullOr(Schema.String)),
  conversationId: Schema.optional(Schema.NullOr(Schema.String)),
  turnId: Schema.optional(Schema.NullOr(Schema.String)),
  toolUseId: Schema.optional(Schema.NullOr(Schema.String)),
  hookEventName: Schema.optional(Schema.NullOr(Schema.String)),
  model: Schema.optional(Schema.NullOr(Schema.String)),
})

const WireArc = Schema.Struct({
  chatId: Schema.optional(Schema.NullOr(Schema.String)),
  targetSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  targetProvider: Schema.optional(Schema.NullOr(Schema.String)),
  hookSockPresent: Schema.optional(Schema.Boolean),
})

/** Versioned wire record from `arc-hook-signal.mjs`, and the `envelope` persisted
 * to `raw_hook_signals.payloadJson`. The most untrusted input in the app: raw
 * JSON from external harness processes — so it is decoded, not cast, on ingest
 * and on replay. Every field is optional and `hookInput` stays `unknown` (the
 * inner harness payload is genuinely polymorphic across providers). Legacy flat
 * fields stay readable for records written before the nested envelope. */
export const HookSignalWire = Schema.Struct({
  schemaVersion: Schema.optional(Schema.Number),
  helperVersion: Schema.optional(Schema.Number),
  declaredProvider: Schema.optional(Schema.String),
  declaredEvent: Schema.optional(Schema.String),
  observedAt: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.NullOr(Schema.String)),
  pid: Schema.optional(Schema.NullOr(Schema.Number)),
  argv: Schema.optional(Schema.Array(Schema.String)),
  hookInputParseOk: Schema.optional(Schema.Boolean),
  hookInputSha256: Schema.optional(Schema.String),
  native: Schema.optional(WireNative),
  arc: Schema.optional(WireArc),
  /** Present only in the persisted envelope: the resolved-provider snapshot. */
  resolvedProvider: Schema.optional(Schema.String),
  /** @deprecated legacy flat field — prefer `declaredProvider` */
  provider: Schema.optional(Schema.String),
  /** @deprecated legacy flat field — prefer `declaredEvent` */
  event: Schema.optional(Schema.String),
  /** @deprecated legacy flat field — prefer `native.sessionId` */
  sessionId: Schema.optional(Schema.NullOr(Schema.String)),
  arcTargetSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  arcChatSessionId: Schema.optional(Schema.NullOr(Schema.String)),
  arcTargetProvider: Schema.optional(Schema.NullOr(Schema.String)),
  at: Schema.optional(Schema.String),
  hookInput: Schema.optional(Schema.Unknown),
})
export type HookSignalWire = typeof HookSignalWire.Type

/** A validated binding: both ids present. The product of a usable wire record. */
export interface HookBinding {
  readonly provider: string
  readonly event: string
  readonly targetSessionId: TargetId
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
  readonly arcTargetSessionId: TargetId | null
  readonly arcChatSessionId: ChatId | null
  readonly arcTargetProvider: string | null
}

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null
const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)
const bool = (v: unknown): boolean => v === true

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
  wire: HookSignalWire,
  hookInput: Record<string, unknown> | null,
): HookSignalNative => ({
  sessionId:
    str(wire.native?.sessionId) ??
    str(wire.sessionId) ??
    sessionIdFrom(hookInput) ??
    conversationIdFrom(hookInput),
  transcriptPath: str(wire.native?.transcriptPath) ?? transcriptPathFrom(hookInput),
  conversationId: str(wire.native?.conversationId) ?? conversationIdFrom(hookInput),
  turnId: str(wire.native?.turnId) ?? firstStr(hookInput, ["turn_id", "turnId"]),
  toolUseId: str(wire.native?.toolUseId) ?? firstStr(hookInput, ["tool_use_id", "toolUseId"]),
  hookEventName:
    str(wire.native?.hookEventName) ?? firstStr(hookInput, ["hook_event_name", "hookEventName"]),
  model: str(wire.native?.model) ?? str(hookInput?.["model"] ?? null),
})

const arcFrom = (wire: HookSignalWire): HookSignalArc => ({
  chatId: arcIdOrNull("chat", str(wire.arc?.chatId) ?? str(wire.arcChatSessionId)),
  targetSessionId: arcIdOrNull("target", str(wire.arc?.targetSessionId) ?? str(wire.arcTargetSessionId)),
  targetProvider: str(wire.arc?.targetProvider) ?? str(wire.arcTargetProvider),
  hookSockPresent: bool(wire.arc?.hookSockPresent),
})

const sha256Hex = (raw: string): string => createHash("sha256").update(raw).digest("hex")

/** Why a wire line was dropped instead of becoming a {@link HookSignal}. Rides the
 * `Result` failure channel so the server can log the reason; a real `Error`
 * subclass, so unwrapping a known-good fixture with `Result.getOrThrow` rethrows
 * it cleanly. */
export class HookSignalDropped extends Data.TaggedError("arc/HookSignalDropped")<{
  readonly reason: string
}> {}

const dropped = (reason: string): HookSignalDropped => new HookSignalDropped({ reason })

const decodeWire = Schema.decodeUnknownResult(Schema.fromJsonString(HookSignalWire))

const parseWireLine = (line: string): Result.Result<HookSignalWire, HookSignalDropped> => {
  const trimmed = line.trim()
  if (!trimmed) return Result.fail(dropped("empty line"))
  return Result.mapError(decodeWire(trimmed), () => dropped(`invalid wire record: ${trimmed.slice(0, 120)}`))
}

/** Decode one wire line into a {@link HookSignal}, or the reason it was dropped. */
export const toSignal = (line: string): Result.Result<HookSignal, HookSignalDropped> =>
  Result.map(parseWireLine(line), (wire) => {
    const hookInput = wire.hookInput ?? null
    const hookInputObj = isRecord(hookInput) ? hookInput : null
    const declaredProvider = str(wire.declaredProvider) ?? str(wire.provider) ?? "unknown"
    const declaredEvent = str(wire.declaredEvent) ?? str(wire.event) ?? "unknown"
    const native = nativeFrom(wire, hookInputObj)
    const arc = arcFrom(wire)
    return {
      schemaVersion: wire.schemaVersion ?? 0,
      helperVersion: wire.helperVersion ?? 0,
      declaredProvider,
      declaredEvent,
      observedAt: str(wire.observedAt) ?? str(wire.at) ?? new Date().toISOString(),
      cwd: str(wire.cwd),
      pid: wire.pid ?? null,
      argv: wire.argv ?? [],
      hookInput,
      hookInputParseOk: bool(wire.hookInputParseOk),
      hookInputSha256:
        str(wire.hookInputSha256) ??
        sha256Hex(typeof hookInput === "string" ? hookInput : JSON.stringify(hookInput ?? "")),
      native,
      arc,
      provider: resolveProvider(declaredProvider, hookInputObj),
      event: declaredEvent,
      sessionId: native.sessionId,
      arcTargetSessionId: arc.targetSessionId,
      arcChatSessionId: arc.chatId,
      arcTargetProvider: arc.targetProvider,
    }
  })

/**
 * Parse + validate one received line into a binding. The failure channel names
 * *why* a record was dropped (Codex tightening #3: defensively validate before
 * mutating session state).
 */
export const toBinding = (line: string): Result.Result<HookBinding, HookSignalDropped> =>
  Result.flatMap(toSignal(line), ({ provider, event, sessionId, arcTargetSessionId, arcTargetProvider, native }) => {
    if (!sessionId) return Result.fail(dropped("missing native session_id"))
    if (!arcTargetSessionId) return Result.fail(dropped("missing arcTargetSessionId"))
    if (arcTargetProvider && provider !== arcTargetProvider) {
      return Result.fail(dropped(`provider mismatch: payload=${provider} target=${arcTargetProvider}`))
    }
    return Result.succeed({
      provider,
      event,
      targetSessionId: arcTargetSessionId,
      nativeSessionId: sessionId,
      transcriptPath: native.transcriptPath,
    })
  })
