import { Schema } from "effect"

// --- Cursor ACP (Agent Client Protocol) wire shapes ------------------------
// `cursor-agent acp` speaks newline-delimited JSON-RPC 2.0 on stdio. A turn is a
// `session/prompt` request whose response (`{ stopReason }`) is the completion
// signal; while it runs, `session/update` notifications stream the transcript.
// Every variant is decoded the same way the rollout-file providers decode their
// records: `decode*Option`, so an unknown/malformed shape decodes to None and is
// skipped rather than throwing. `NonEmptyString` treats "" as absent.
//
// Only the subset a normal coding turn produces is mirrored here; `session_info_update`
// / `available_commands_update` (and the `user_message_chunk` replayed by
// `session/load`) intentionally have no variant, so they decode to None and are
// ignored. Shapes verified live against cursor-agent 2026.07.01.
const NeStr = Schema.NonEmptyString

/** The `session/new` result: `sessionId` is the native session id the turn keys off. */
export const SessionNewResult = Schema.Struct({ sessionId: NeStr })
export const decodeSessionNew = Schema.decodeUnknownOption(SessionNewResult)

/** The `session/prompt` result — its `stopReason` maps to the turn status. */
export const PromptResult = Schema.Struct({ stopReason: Schema.optional(Schema.String) })
export const decodePromptResult = Schema.decodeUnknownOption(PromptResult)

// --- session/update variants -----------------------------------------------

/** An assistant text delta; `content.text` is concatenated into the pending buffer. */
export const AgentMessageChunk = Schema.Struct({
  sessionUpdate: Schema.Literal("agent_message_chunk"),
  content: Schema.optional(
    Schema.Struct({ type: Schema.optional(Schema.String), text: Schema.optional(Schema.String) }),
  ),
})

/**
 * A tool call starts. `kind` is "execute" for a shell command; `rawInput` is the
 * tool's args (`{ command }` for execute, other shapes otherwise) — kept
 * `Unknown` and narrowed at the fold, mirroring how the codex driver keeps wire
 * `item`s opaque until the normalizer.
 */
export const ToolCall = Schema.Struct({
  sessionUpdate: Schema.Literal("tool_call"),
  toolCallId: NeStr,
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
})

/**
 * A later status/result for a tool call (merged onto the existing item by
 * `toolCallId`). On completion `rawOutput` is `{ exitCode, stdout, stderr }` for
 * an execute tool.
 */
export const ToolCallUpdate = Schema.Struct({
  sessionUpdate: Schema.Literal("tool_call_update"),
  toolCallId: NeStr,
  status: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
  rawOutput: Schema.optional(Schema.Unknown),
})

export const AcpSessionUpdate = Schema.Union([AgentMessageChunk, ToolCall, ToolCallUpdate])
export type AcpSessionUpdate = typeof AcpSessionUpdate.Type

/** The `session/update` notification params: `{ sessionId, update }`. */
export const SessionUpdateParams = Schema.Struct({ update: AcpSessionUpdate })
export const decodeSessionUpdate = Schema.decodeUnknownOption(SessionUpdateParams)

// --- session/request_permission --------------------------------------------

/** One offered decision — the UI renders `name` and answers with `optionId`. */
export const PermissionOption = Schema.Struct({
  optionId: NeStr,
  name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
})
export type PermissionOption = typeof PermissionOption.Type

const PermissionToolCall = Schema.Struct({
  toolCallId: Schema.optional(Schema.String),
  title: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  rawInput: Schema.optional(Schema.Unknown),
})

/**
 * The params of a `session/request_permission` server→client request. `toolCall`
 * links to the streamed tool item; `options` is the server-supplied answer set
 * the UI must offer verbatim (rendered by `name`, answered by `optionId`).
 */
export const RequestPermissionParams = Schema.Struct({
  toolCall: Schema.optional(PermissionToolCall),
  options: Schema.optional(Schema.Array(PermissionOption)),
})
export type RequestPermissionParams = typeof RequestPermissionParams.Type
export const decodePermissionParams = Schema.decodeUnknownOption(RequestPermissionParams)
