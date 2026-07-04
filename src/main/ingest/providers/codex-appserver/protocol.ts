import { Schema } from "effect"

// --- codex app-server wire items -------------------------------------------
// `codex app-server` (JSON-RPC 2.0 over stdio) streams a turn as `item/*`
// notifications; the authoritative final state of each arrives on
// `item/completed` as an `item` whose own `type` discriminates the variant.
// These schemas cover the item variants a normal coding turn produces, decoded
// the same way as the rollout-file provider (`codex.ts`): a `Schema.Union` per
// discriminant, `decode*Option` so an unknown/malformed shape decodes to None
// and is skipped rather than throwing. `NonEmptyString` mirrors the flat
// provider's treatment of "" as absent.
//
// The full protocol for the installed binary is emitted by
// `codex app-server generate-json-schema --out DIR` / `generate-ts --out DIR`;
// this module hand-mirrors only the subset the normalizer consumes today.
// mcpToolCall / fileChange follow the same shape and are added when fixtured.
const NeStr = Schema.NonEmptyString

/** A user turn: `content` is a part array; only text parts are renderable here. */
export const UserMessageItem = Schema.Struct({
  type: Schema.Literal("userMessage"),
  id: Schema.optional(Schema.String),
  content: Schema.optional(
    Schema.Array(Schema.Struct({ type: Schema.String, text: Schema.optional(Schema.String) })),
  ),
})

/** An assistant message chunk. `phase` is "final_answer" | "commentary"; both are text. */
export const AgentMessageItem = Schema.Struct({
  type: Schema.Literal("agentMessage"),
  id: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  phase: Schema.optional(Schema.String),
})

/** A reasoning block. `summary`/`content` are part arrays (often empty). */
export const ReasoningItem = Schema.Struct({
  type: Schema.Literal("reasoning"),
  id: Schema.optional(Schema.String),
  summary: Schema.optional(Schema.Array(Schema.Unknown)),
  content: Schema.optional(Schema.Array(Schema.Unknown)),
})

/**
 * A shell command run. Unlike the rollout-file provider — which recovers the
 * body + exit code by regex-stripping a `Chunk ID / Wall time / Process exited
 * with code N / Output:` telemetry preamble out of the result *text* — the
 * app-server delivers `command`, `exitCode`, and `aggregatedOutput` as first-
 * class fields. `aggregatedOutput` is null when the command produced no output.
 */
export const CommandExecutionItem = Schema.Struct({
  type: Schema.Literal("commandExecution"),
  id: NeStr,
  command: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  status: Schema.optional(Schema.String),
  exitCode: Schema.optional(Schema.NullOr(Schema.Number)),
  aggregatedOutput: Schema.optional(Schema.NullOr(Schema.String)),
})

export const AppServerItem = Schema.Union([
  UserMessageItem,
  AgentMessageItem,
  ReasoningItem,
  CommandExecutionItem,
])
export type AppServerItem = typeof AppServerItem.Type
export const decodeItem = Schema.decodeUnknownOption(AppServerItem)

// --- token usage -----------------------------------------------------------
// `thread/tokenUsage/updated` params. `last` is the delta for the turn just
// completed; `total` the running thread total. Mirrors the rollout provider's
// `token_count` handling (which keys off `last`).
const TokenAmounts = Schema.Struct({
  totalTokens: Schema.optional(Schema.Number),
  inputTokens: Schema.optional(Schema.Number),
  cachedInputTokens: Schema.optional(Schema.Number),
  outputTokens: Schema.optional(Schema.Number),
  reasoningOutputTokens: Schema.optional(Schema.Number),
})

export const TokenUsageParams = Schema.Struct({
  tokenUsage: Schema.Struct({
    total: Schema.optional(TokenAmounts),
    last: Schema.optional(TokenAmounts),
    modelContextWindow: Schema.optional(Schema.Number),
  }),
})
export type TokenUsageParams = typeof TokenUsageParams.Type
export const decodeUsage = Schema.decodeUnknownOption(TokenUsageParams)

// --- driver-facing method payloads -----------------------------------------
// The `thread/start` response carries the thread id the rest of the session
// keys off — a missing one is fatal, so the driver decodes to Option and fails.
export const ThreadStartResult = Schema.Struct({ thread: Schema.Struct({ id: NeStr }) })
export const decodeThreadStart = Schema.decodeUnknownOption(ThreadStartResult)

/**
 * The params of an `item/<kind>/requestApproval` server→client request. `itemId`
 * links to the exact tool-call item already streamed; `availableDecisions` is
 * the server-supplied set of allowable answers (accept / acceptForSession /
 * acceptWithExecpolicyAmendment / cancel …) the UI must offer verbatim.
 */
export const ApprovalRequestParams = Schema.Struct({
  itemId: Schema.optional(Schema.String),
  command: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  reason: Schema.optional(Schema.String),
  availableDecisions: Schema.optional(Schema.Array(Schema.Unknown)),
})
export type ApprovalRequestParams = typeof ApprovalRequestParams.Type
export const decodeApprovalParams = Schema.decodeUnknownOption(ApprovalRequestParams)
