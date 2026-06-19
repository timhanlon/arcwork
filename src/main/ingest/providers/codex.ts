import { Effect, FileSystem, Path } from "effect"
import { homedir } from "node:os"
import type { DiagnosticRow, ExtractedRows } from "../db/schema.js"
import type { IngestError } from "../errors.js"
import { classifyTool } from "../extract/tool-kind.js"
import { SessionRowBuilder } from "../extract/session-row-builder.js"
import { readJsonl } from "./jsonl.js"
import type { AgentProvider } from "./provider.js"

type Rec = Record<string, unknown>

const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined)
const obj = (v: unknown): Rec | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined

const parseJson = (raw: string): Rec | undefined => {
  try {
    return obj(JSON.parse(raw))
  } catch {
    return undefined
  }
}

// Codex wraps every exec/shell tool result in a fixed telemetry preamble before
// the real output:
//   Chunk ID: <hex>
//   Wall time: <n> seconds
//   Process exited with code <n>
//   Original token count: <n>
//   Output:
//   <the actual output>
// None of that header reads as anything but noise in the transcript, so strip it
// down to the body. The nonzero exit code is the one bit worth keeping — a failed
// command is a real signal — so surface it as a compact `[exit N]` prefix
// (mirroring claude.ts's `[error]` convention). Outputs that don't match the
// exact shape (MCP tool results, apply_patch echoes, a future format change) pass
// through untouched so we never eat real content.
const EXEC_WRAPPER =
  /^Chunk ID: \S+\nWall time: [\d.]+ seconds\nProcess exited with code (\d+)\nOriginal token count: \d+\nOutput:\n/
const unwrapExecOutput = (output: string): string => {
  const match = EXEC_WRAPPER.exec(output)
  if (!match) return output
  const body = output.slice(match[0].length)
  return match[1] === "0" ? body : `[exit ${match[1]}]\n${body}`
}

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
    const payload = obj(record["payload"])

    if (type === "turn_context") {
      const model = str(payload?.["model"])
      if (model) currentModel = model
      continue
    }

    if (type === "event_msg") {
      switch (payload?.["type"]) {
        case "user_message": {
          const text = str(payload["message"])
          if (text) b.message({ role: "user", text, createdAt: timestamp })
          break
        }
        case "agent_message": {
          const text = str(payload["message"])
          if (text) b.message({ role: "assistant", text, model: currentModel, createdAt: timestamp })
          break
        }
        case "agent_reasoning": {
          const text = str(payload["text"])
          if (text)
            b.message({ role: "assistant", thinking: text, model: currentModel, createdAt: timestamp })
          break
        }
      }
      continue
    }

    if (type === "response_item") {
      switch (payload?.["type"]) {
        case "function_call": {
          const name = str(payload["name"])
          if (!name) break
          const callId = str(payload["call_id"])
          const argsRaw = str(payload["arguments"])
          const input = argsRaw ? parseJson(argsRaw) : undefined
          const row = b.tool({
            name,
            kind: classifyTool("codex", name),
            nativeToolId: callId ?? null,
            inputJson: argsRaw ?? null,
          })
          b.hint(name, input, null, row.id)
          break
        }
        case "custom_tool_call": {
          const name = str(payload["name"])
          if (!name) break
          const callId = str(payload["call_id"])
          const inputText = str(payload["input"]) ?? ""
          const row = b.tool({
            name,
            kind: classifyTool("codex", name),
            nativeToolId: callId ?? null,
            inputJson: JSON.stringify({ input: inputText }),
          })
          b.hint(name, { input: inputText }, null, row.id)
          break
        }
        case "function_call_output":
        case "custom_tool_call_output": {
          const callId = str(payload["call_id"])
          const output = str(payload["output"])
          if (callId && output) b.result(callId, unwrapExecOutput(output))
          break
        }
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

/** Read just the first line of a file (Codex session_meta) without loading the whole file. */
const readFirstLine = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string, IngestError> =>
  Effect.scoped(
    Effect.gen(function* () {
      const file = yield* fs.open(path)
      const buffer = new Uint8Array(64 * 1024)
      const bytes = yield* file.read(buffer)
      const text = new TextDecoder().decode(buffer.subarray(0, Number(bytes)))
      const newline = text.indexOf("\n")
      return newline >= 0 ? text.slice(0, newline) : text
    }),
  ).pipe(Effect.orElseSucceed(() => ""))

interface CodexFileMeta {
  readonly path: string
  readonly nativeSessionId: string
  readonly cwd: string
  readonly createdAt?: string
}

export const makeCodexProvider: Effect.Effect<AgentProvider, never, FileSystem.FileSystem | Path.Path> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = path.join(homedir(), ".codex", "sessions")

    /** All rollout files with their session_meta, anywhere under the date tree. */
    const scan = Effect.gen(function* () {
      if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false)))) {
        return [] as ReadonlyArray<CodexFileMeta>
      }
      const entries = yield* fs
        .readDirectory(root, { recursive: true })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
      const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(root, name))

      const metas: Array<CodexFileMeta> = []
      for (const file of files) {
        const line = yield* readFirstLine(fs, file)
        if (line.length === 0) continue
        const parsed = parseJson(line)
        if (!parsed || parsed["type"] !== "session_meta") continue
        const payload = obj(parsed["payload"])
        const nativeSessionId = str(payload?.["id"])
        const cwd = str(payload?.["cwd"])
        if (!nativeSessionId || !cwd) continue
        metas.push({
          path: file,
          nativeSessionId,
          cwd,
          ...(str(payload?.["timestamp"]) ? { createdAt: str(payload?.["timestamp"])! } : {}),
        })
      }
      return metas
    })

    // Scan session_meta headers once, then read+normalize each matching file.
    // Each file is one session, so this is already O(transcript) — no re-parse.
    const collect = (workspace: string) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(workspace).pipe(Effect.orElseSucceed(() => workspace))
        const metas = yield* scan
        const matched = metas.filter((m) => m.cwd === real || m.cwd === workspace)
        const out: Array<ExtractedRows> = []
        for (const m of matched) {
          const result = yield* readJsonl(fs, "codex", m.path)
          out.push(
            normalizeCodexRecords(result.records, {
              nativeSessionId: m.nativeSessionId,
              sourcePath: m.path,
              workspaceRoot: real,
              diagnostics: result.parseErrors.map((e) => ({
                severity: "warning",
                code: "corrupt_jsonl_line",
                message: `line ${e.line}: ${e.message}`,
                sourcePath: m.path,
              })),
            }),
          )
        }
        return out
      })

    return { id: "codex", collect } satisfies AgentProvider
  })
