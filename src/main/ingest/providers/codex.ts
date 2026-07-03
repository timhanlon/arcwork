import { type Effect, type FileSystem, Option, type Path, Schema } from "effect"
import { homedir } from "node:os"
import type { DiagnosticRow, ExtractedRows } from "../db/schema.js"
import { classifyTool } from "../extract/tool-kind.js"
import { SessionRowBuilder } from "../extract/session-row-builder.js"
import { makeJsonlSessionProvider } from "./jsonl-provider.js"
import type { AgentProvider } from "./provider.js"
import { type Rec, obj, parseJson, str } from "../extract/json.js"

// --- record payload schemas ------------------------------------------------
// A Codex record is `{ type, timestamp, payload }`; the payload's own `type`
// discriminates the variants. Decoding each payload into a Schema.Union gives
// typed fields with no `str(payload["…"])` plucking — and because an unknown or
// malformed shape decodes to None, the variant is skipped, exactly as the prior
// `if (str(...)) …` guards did. `NonEmptyString` mirrors str()'s treatment of
// "" as absent; fields the old code required for an action are required members
// (a missing one drops the variant, matching the old `if (!name) break` / the
// `callId && output` guard). The trivial envelope reads (type/timestamp) and the
// raw session_meta passthrough stay as direct reads — decoding them would only
// add fragility (one malformed top-level field would drop the whole record).
const NeStr = Schema.NonEmptyString

const TokenUsage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  cached_input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
  reasoning_output_tokens: Schema.optional(Schema.Number),
  total_tokens: Schema.optional(Schema.Number),
})

const EventMsgPayload = Schema.Union([
  Schema.Struct({ type: Schema.Literal("user_message"), message: NeStr }),
  Schema.Struct({ type: Schema.Literal("agent_message"), message: NeStr }),
  Schema.Struct({ type: Schema.Literal("agent_reasoning"), text: NeStr }),
  Schema.Struct({
    type: Schema.Literal("token_count"),
    info: Schema.Struct({
      total_token_usage: Schema.optional(TokenUsage),
      last_token_usage: Schema.optional(TokenUsage),
      model_context_window: Schema.optional(Schema.Number),
    }),
    rate_limits: Schema.optional(
      Schema.Struct({
        primary: Schema.optional(Schema.Struct({ used_percent: Schema.optional(Schema.Number) })),
        secondary: Schema.optional(Schema.Struct({ used_percent: Schema.optional(Schema.Number) })),
      }),
    ),
  }),
])
const decodeEventMsg = Schema.decodeUnknownOption(EventMsgPayload)

const ResponseItemPayload = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("function_call"),
    name: NeStr,
    call_id: Schema.optional(NeStr),
    arguments: Schema.optional(NeStr),
  }),
  Schema.Struct({
    type: Schema.Literal("custom_tool_call"),
    name: NeStr,
    call_id: Schema.optional(NeStr),
    // input may legitimately be the empty string (the old code defaulted it to
    // ""), so it's a plain optional String, not NonEmptyString.
    input: Schema.optional(Schema.String),
  }),
  Schema.Struct({ type: Schema.Literal("function_call_output"), call_id: NeStr, output: NeStr }),
  Schema.Struct({ type: Schema.Literal("custom_tool_call_output"), call_id: NeStr, output: NeStr }),
])
const decodeResponseItem = Schema.decodeUnknownOption(ResponseItemPayload)

const decodeTurnContext = Schema.decodeUnknownOption(Schema.Struct({ model: Schema.optional(NeStr) }))

const SessionMetaHeader = Schema.Struct({
  type: Schema.Literal("session_meta"),
  payload: Schema.Struct({
    id: Schema.optional(NeStr),
    cwd: Schema.optional(NeStr),
    timestamp: Schema.optional(NeStr),
  }),
})
const decodeSessionMetaLine = Schema.decodeUnknownOption(Schema.fromJsonString(SessionMetaHeader))

// Codex wraps tool results in a fixed telemetry preamble before the real output.
// Two shapes occur in practice:
//   exec/shell:                       MCP tool calls:
//     Chunk ID: <hex>                   Wall time: <n> seconds
//     Wall time: <n> seconds            Output:
//     Process exited with code <n>      <the actual output>
//     Original token count: <n>
//     Output:
//     <the actual output>
// The MCP shape drops Chunk ID, the exit-code line, and the token count — only
// `Wall time:` and `Output:` are guaranteed — so those three lines are optional
// here. None of the header reads as anything but noise in the transcript, so
// strip it down to the body. The nonzero exit code is the one bit worth keeping —
// a failed command is a real signal — so surface it as a compact `[exit N]`
// prefix (mirroring claude.ts's `[error]` convention); MCP results carry no exit
// code, so nothing is prefixed there. Outputs that don't match (apply_patch
// echoes, a future format change) pass through untouched so we never eat content.
const EXEC_WRAPPER =
  /^(?:Chunk ID: \S+\n)?Wall time: [\d.]+ seconds\n(?:Process exited with code (\d+)\n)?(?:Original token count: \d+\n)?Output:\n/
const unwrapExecOutput = (output: string): string => {
  const match = EXEC_WRAPPER.exec(output)
  if (!match) return output
  const body = output.slice(match[0].length)
  const exitCode = match[1]
  return exitCode === undefined || exitCode === "0" ? body : `[exit ${exitCode}]\n${body}`
}

const finite = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value

// ---------------------------------------------------------------------------
// Pure: fold a Codex rollout's records into rows.
// Codex JSONL is a chronological event stream (no DAG): session_meta, then
// event_msg (user/agent/reasoning/token_count) and response_item (function /
// custom tool calls + their outputs), with turn_context carrying the model.
// ---------------------------------------------------------------------------

export interface CodexNormalizeOptions {
  readonly nativeSessionId: string
  readonly sourcePath: string
  readonly workspaceRoot: string
  readonly title?: string
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

export const sessionMetaOf = (records: ReadonlyArray<Rec>): Rec | undefined => {
  const first = records.find((r) => r["type"] === "session_meta")
  return first ? obj(first["payload"]) : undefined
}

export const normalizeCodexRecords = (
  records: ReadonlyArray<Rec>,
  options: CodexNormalizeOptions,
): ExtractedRows => {
  const b = new SessionRowBuilder("codex", options.nativeSessionId)
  let currentModel: string | null = null

  const meta = sessionMetaOf(records)
  // Codex carries no per-record DAG: created_at is the session_meta timestamp,
  // updated_at the last record seen. (observeTimestamp would derive created_at
  // from the first record, which Codex deliberately does not do.)
  b.createdAt = str(meta?.["timestamp"])

  for (const record of records) {
    const type = str(record["type"])
    const timestamp = str(record["timestamp"]) ?? null
    if (timestamp) b.updatedAt = timestamp
    const payload = record["payload"]

    if (type === "turn_context") {
      const tc = decodeTurnContext(payload)
      if (Option.isSome(tc) && tc.value.model) currentModel = tc.value.model
      continue
    }

    if (type === "event_msg") {
      const ev = decodeEventMsg(payload)
      if (Option.isNone(ev)) continue
      switch (ev.value.type) {
        case "user_message":
          b.message({ role: "user", text: ev.value.message, createdAt: timestamp })
          break
        case "agent_message":
          b.message({ role: "assistant", text: ev.value.message, model: currentModel, createdAt: timestamp })
          break
        case "agent_reasoning":
          b.message({ role: "assistant", thinking: ev.value.text, model: currentModel, createdAt: timestamp })
          break
        case "token_count": {
          const last = ev.value.info.last_token_usage
          const inputTokens = finite(last?.input_tokens)
          b.usage({
            occurredAt: timestamp,
            model: currentModel,
            contextUsedTokens: inputTokens,
            contextWindowTokens: finite(ev.value.info.model_context_window),
            inputTokens,
            outputTokens: finite(last?.output_tokens),
            rawJson: JSON.stringify(payload),
          })
          break
        }
      }
      continue
    }

    if (type === "response_item") {
      const ri = decodeResponseItem(payload)
      if (Option.isNone(ri)) continue
      const p = ri.value
      switch (p.type) {
        case "function_call": {
          const input = p.arguments ? parseJson(p.arguments) : undefined
          const row = b.tool({
            name: p.name,
            kind: classifyTool("codex", p.name),
            nativeToolId: p.call_id ?? null,
            inputJson: p.arguments ?? null,
          })
          b.hint(p.name, input, null, row.id)
          break
        }
        case "custom_tool_call": {
          const inputText = p.input ?? ""
          const row = b.tool({
            name: p.name,
            kind: classifyTool("codex", p.name),
            nativeToolId: p.call_id ?? null,
            inputJson: JSON.stringify({ input: inputText }),
          })
          b.hint(p.name, { input: inputText }, null, row.id)
          break
        }
        case "function_call_output":
        case "custom_tool_call_output":
          b.result(p.call_id, unwrapExecOutput(p.output))
          break
      }
    }
  }

  return b.finish({
    nativeSessionId: options.nativeSessionId,
    workspaceRoot: options.workspaceRoot,
    sourcePath: options.sourcePath,
    title: options.title,
    rawMetadataJson: meta ? JSON.stringify(meta) : null,
    diagnostics: options.diagnostics,
  })
}

// ---------------------------------------------------------------------------
// Provider (IO): discover rollout files, match by session_meta.cwd, extract.
// ---------------------------------------------------------------------------

export const makeCodexProvider: Effect.Effect<AgentProvider, never, FileSystem.FileSystem | Path.Path> =
  makeJsonlSessionProvider({
    id: "codex",
    root: (path) => path.join(homedir(), ".codex", "sessions"),
    readMeta: (line) => {
      const header = decodeSessionMetaLine(line)
      if (Option.isNone(header)) return undefined
      const { id, cwd } = header.value.payload
      return id && cwd ? { nativeSessionId: id, cwd } : undefined
    },
    normalize: normalizeCodexRecords,
  })
