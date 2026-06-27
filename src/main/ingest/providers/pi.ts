import { type Effect, type FileSystem, Option, type Path, Schema } from "effect"
import { homedir } from "node:os"
import type { DiagnosticRow, ExtractedRows } from "../db/schema.js"
import { classifyTool } from "../extract/tool-kind.js"
import { SessionRowBuilder } from "../extract/session-row-builder.js"
import { makeJsonlSessionProvider } from "./jsonl-provider.js"
import type { AgentProvider } from "./provider.js"
import { type Rec, arr, obj, str } from "../extract/json.js"

// pi (@earendil-works/pi-coding-agent) writes one JSONL session file per session
// under `~/.pi/agent/sessions/<encoded-cwd>/<ts>_<uuid>.jsonl`. The first line is
// a `session` header carrying `id` (the native session id) + `cwd`; the rest are
// `model_change` and `message` entries. A `message` wraps `{role, content[]}`:
//   user      → content `text` parts
//   assistant → content `thinking` / `text` / `toolCall {id,name,arguments}` parts
//   toolResult→ `{toolCallId, toolName, content[], isError}` (the call's output)

const NeStr = Schema.NonEmptyString

// An assistant message's content parts, discriminated by `type`. Decoding each
// part into this union replaces the `switch (str(c["type"]))` plucking; an
// unknown or malformed part decodes to None and is skipped (as the old default
// case did). `text`/`thinking` are plain optional Strings (the old code summed
// them with `?? ""`, so "" is meaningful), `toolCall.name` is required NonEmpty
// (the old code pushed a call only `if (str(c["name"]))`).
const ContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.optional(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.optional(Schema.String) }),
  Schema.Struct({
    type: Schema.Literal("toolCall"),
    name: NeStr,
    id: Schema.optional(NeStr),
    arguments: Schema.optional(Schema.Unknown),
  }),
])
type ToolCallPart = Extract<typeof ContentPart.Type, { type: "toolCall" }>
const decodeContentPart = Schema.decodeUnknownOption(ContentPart)

const PiSessionHeader = Schema.Struct({
  type: Schema.Literal("session"),
  id: Schema.optional(NeStr),
  cwd: Schema.optional(NeStr),
})
const decodePiSessionLine = Schema.decodeUnknownOption(Schema.fromJsonString(PiSessionHeader))

/** Join the `text` parts of a content array (used for user + toolResult output). */
const textOf = (content: unknown): string =>
  arr(content)
    .map((part) => decodeContentPart(part))
    .map((p) => (Option.isSome(p) && p.value.type === "text" ? (p.value.text ?? "") : ""))
    .join("")

export interface PiNormalizeOptions {
  readonly nativeSessionId: string
  readonly sourcePath: string
  readonly workspaceRoot: string
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

// ---------------------------------------------------------------------------
// Pure: fold a pi session's records into rows. Chronological event stream; the
// builder assigns ordinals in source order, so a thinking/text/toolCall sequence
// inside one assistant message keeps its order.
// ---------------------------------------------------------------------------
export const normalizePiRecords = (
  records: ReadonlyArray<Rec>,
  options: PiNormalizeOptions,
): ExtractedRows => {
  const b = new SessionRowBuilder("pi", options.nativeSessionId)
  let currentModel: string | null = null
  const meta = records.find((r) => r["type"] === "session")
  b.createdAt = str(meta?.["timestamp"])

  for (const record of records) {
    const type = str(record["type"])
    const timestamp = str(record["timestamp"]) ?? null
    if (timestamp) b.updatedAt = timestamp

    if (type === "model_change") {
      currentModel = str(record["modelId"]) ?? currentModel
      continue
    }
    if (type !== "message") continue

    const message = obj(record["message"])
    if (!message) continue
    const role = str(message["role"])
    const nativeMessageId = str(record["id"]) ?? null

    if (role === "user") {
      const text = textOf(message["content"])
      if (text) b.message({ role: "user", text, createdAt: timestamp, nativeMessageId })
      continue
    }

    if (role === "assistant") {
      const model = str(message["model"]) ?? currentModel
      // Coalesce the entry's content parts into ONE assistant message — text is
      // the body, thinking rides the (hidden) thinking column. A part-per-message
      // split would surface each thinking block as its own chat bubble, since the
      // body projection falls back to `text ?? thinking`. Tool calls keep their
      // own rows, appended in source order after the message.
      let text = ""
      let thinking = ""
      const toolCalls: Array<ToolCallPart> = []
      for (const part of arr(message["content"])) {
        const p = decodeContentPart(part)
        if (Option.isNone(p)) continue
        switch (p.value.type) {
          case "text":
            text += p.value.text ?? ""
            break
          case "thinking":
            thinking += p.value.thinking ?? ""
            break
          case "toolCall":
            toolCalls.push(p.value)
            break
        }
      }
      // Only emit a bubble when there's actual response text; a thinking-only
      // (or whitespace-only) entry leaves no standalone/empty assistant message.
      if (text.trim()) {
        b.message({
          role: "assistant",
          text,
          thinking: thinking || null,
          model,
          createdAt: timestamp,
          nativeMessageId,
        })
      }
      for (const tc of toolCalls) {
        const input = obj(tc.arguments)
        const row = b.tool({
          name: tc.name,
          kind: classifyTool("pi", tc.name),
          nativeToolId: tc.id ?? null,
          inputJson: JSON.stringify(tc.arguments ?? {}),
        })
        b.hint(tc.name, input, null, row.id)
      }
      continue
    }

    if (role === "toolResult") {
      const output = textOf(message["content"])
      b.result(str(message["toolCallId"]), message["isError"] === true ? `[error]\n${output}` : output)
    }
  }

  return b.finish({
    nativeSessionId: options.nativeSessionId,
    workspaceRoot: options.workspaceRoot,
    sourcePath: options.sourcePath,
    rawMetadataJson: meta ? JSON.stringify(meta) : null,
    diagnostics: options.diagnostics,
  })
}

// ---------------------------------------------------------------------------
// Provider (IO): scan session headers, match by the `session` entry's cwd.
// ---------------------------------------------------------------------------
export const makePiProvider: Effect.Effect<AgentProvider, never, FileSystem.FileSystem | Path.Path> =
  makeJsonlSessionProvider({
    id: "pi",
    root: (path) => path.join(homedir(), ".pi", "agent", "sessions"),
    readMeta: (line) => {
      const header = decodePiSessionLine(line)
      if (Option.isNone(header)) return undefined
      const { id, cwd } = header.value
      return id && cwd ? { nativeSessionId: id, cwd } : undefined
    },
    normalize: normalizePiRecords,
  })
