import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { SqliteClient } from "@effect/sql-sqlite-node"
import { createHash } from "node:crypto"
import { copyFileSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import type { DiagnosticRow, ExtractedRows } from "../db/schema.js"
import { CursorReadError, type IngestError } from "../errors.js"
import { classifyTool } from "../extract/tool-kind.js"
import { SessionRowBuilder } from "../extract/session-row-builder.js"
import type { AgentProvider } from "./provider.js"
import { type Rec, obj, parseJson, str } from "../extract/json.js"

/** A tool-result's `result` as display text: strings pass through; objects/arrays
 * (how Cursor stores MCP results) are JSON-serialized; null/empty becomes undefined. */
const toolResultText = (raw: unknown): string | undefined => {
  if (typeof raw === "string") return raw.length > 0 ? raw : undefined
  if (raw === null || raw === undefined) return undefined
  try {
    return JSON.stringify(raw, null, 2)
  } catch {
    return undefined
  }
}

// ---------------------------------------------------------------------------
// Pure: recover JSON from Cursor's binary blobs and order them via the
// reference DAG (ported from SpecStory's cursorcli blob_parser/dag_sort).
// ---------------------------------------------------------------------------

const JSON_MARKERS = ['{"id":', '{"role":', '{"type":', '{"content":', '{"']

/** Cursor embeds a JSON object inside each binary blob. Find its start, then brace-match its end. */
export const extractJsonFromBinary = (data: Uint8Array): string | null => {
  const latin1 = Buffer.from(data).toString("latin1")
  let start = -1
  for (const marker of JSON_MARKERS) {
    const idx = latin1.indexOf(marker)
    if (idx !== -1 && (start === -1 || idx < start)) start = idx
  }
  if (start === -1) return null

  let depth = 0
  let inString = false
  let escaped = false
  for (let i = start; i < latin1.length; i++) {
    const c = latin1[i]
    if (inString) {
      if (escaped) escaped = false
      else if (c === "\\") escaped = true
      else if (c === '"') inString = false
    } else if (c === '"') {
      inString = true
    } else if (c === "{") {
      depth++
    } else if (c === "}") {
      depth--
      if (depth === 0) return Buffer.from(data).subarray(start, i + 1).toString("utf8")
    }
  }
  return null
}

/**
 * Extract referenced blob ids. Cursor stores references as protobuf
 * length-delimited fields: tag (0x0a/0x12), length 0x20, then a 32-byte id.
 * An entropy check (>= 8 non-printable bytes) rejects ASCII text false positives.
 */
export const parseReferences = (data: Uint8Array): ReadonlyArray<string> => {
  const refs: Array<string> = []
  const seen = new Set<string>()
  const n = data.length
  for (let i = 0; i < n - 33; i++) {
    if ((data[i] === 0x0a || data[i] === 0x12) && data[i + 1] === 0x20 && i + 34 <= n) {
      const idBytes = data.subarray(i + 2, i + 34)
      let nonPrintable = 0
      for (const b of idBytes) if (b < 0x20 || b > 0x7e) nonPrintable++
      if (nonPrintable >= 8) {
        const hex = Buffer.from(idBytes).toString("hex")
        if (!seen.has(hex)) {
          refs.push(hex)
          seen.add(hex)
          i += 33
        }
      }
    }
  }
  return refs
}

export interface CursorBlob {
  readonly rowid: number
  readonly id: string
  readonly json: string
  readonly refs: ReadonlyArray<string>
}

/**
 * Order blobs by walking the reference DAG backwards from the end blob
 * (preferring `latestRootBlobId` from metadata, else the most-referencing blob),
 * post-order so dependencies precede dependents. Unvisited blobs are orphans.
 */
export const topologicalSort = (
  blobs: ReadonlyArray<CursorBlob>,
  endBlobId?: string,
): { sorted: ReadonlyArray<CursorBlob>; orphaned: ReadonlyArray<CursorBlob> } => {
  const byId = new Map(blobs.map((b) => [b.id, b]))

  let end: CursorBlob | undefined = endBlobId ? byId.get(endBlobId) : undefined
  if (!end) {
    let maxRefs = -1
    for (const b of blobs) {
      if (b.refs.length > maxRefs || (b.refs.length === maxRefs && end && b.rowid > end.rowid)) {
        maxRefs = b.refs.length
        end = b
      }
    }
  }

  const sorted: Array<CursorBlob> = []
  const visited = new Set<string>()
  const traverse = (id: string): void => {
    if (visited.has(id)) return
    const b = byId.get(id)
    if (!b) return
    visited.add(id)
    for (const ref of b.refs) traverse(ref)
    sorted.push(b)
  }
  if (end) traverse(end.id)

  const orphaned = blobs.filter((b) => !visited.has(b.id))
  return { sorted, orphaned }
}

const blobContent = (blob: Rec): ReadonlyArray<Rec> =>
  Array.isArray(blob["content"]) ? (blob["content"] as ReadonlyArray<unknown>).map((p) => obj(p)).filter((p): p is Rec => p !== undefined) : []

// ---------------------------------------------------------------------------
// Pure: normalize ordered blob JSON ({role, id, content[]}) into rows.
// ---------------------------------------------------------------------------

const stripUserQuery = (text: string): string => {
  const t = text.trim()
  if (t.startsWith("<user_query>") && t.endsWith("</user_query>")) {
    return t.slice("<user_query>".length, t.length - "</user_query>".length).trim()
  }
  return text
}

const NeStr = Schema.NonEmptyString

// A Cursor blob's content parts, discriminated by `type`. Decoding each part
// into this union replaces the per-part `obj` + `switch (part["type"])` +
// `str(part["…"])` plucking; an unknown/malformed part decodes to None and is
// skipped (as the old default case did). `text` is optional NonEmpty (the old
// code pushed only `if (str(text))`); unlike codex/pi, `tool-call.toolName` is
// optional — Cursor emits null-named calls, which the old code kept as
// `name ?? null`.
const CursorContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.optional(NeStr) }),
  Schema.Struct({ type: Schema.Literal("reasoning"), text: Schema.optional(NeStr) }),
  Schema.Struct({ type: Schema.Literal("redacted-reasoning"), text: Schema.optional(NeStr) }),
  Schema.Struct({
    type: Schema.Literal("tool-call"),
    toolName: Schema.optional(NeStr),
    toolCallId: Schema.optional(NeStr),
    args: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("tool-result"),
    toolCallId: Schema.optional(NeStr),
    result: Schema.optional(Schema.Unknown),
  }),
])
const decodeCursorPart = Schema.decodeUnknownOption(CursorContentPart)

export interface CursorNormalizeOptions {
  readonly nativeSessionId: string
  readonly sourcePath: string
  readonly workspaceRoot: string
  readonly title?: string
  readonly createdAt?: string
  readonly rawMetadataJson?: string
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

export const normalizeCursorBlobs = (
  blobs: ReadonlyArray<Rec>,
  options: CursorNormalizeOptions,
): ExtractedRows => {
  const b = new SessionRowBuilder("cursor", options.nativeSessionId)

  for (const blob of blobs) {
    const role = str(blob["role"])
    const content = Array.isArray(blob["content"]) ? (blob["content"] as ReadonlyArray<unknown>) : []
    const nativeId = str(blob["id"]) ?? null
    if (content.length === 0) continue

    if (role === "user") {
      const parts = content.map((item) => decodeCursorPart(item))
      const first = parts[0]
      if (
        first !== undefined &&
        Option.isSome(first) &&
        first.value.type === "text" &&
        (first.value.text ?? "").trimStart().startsWith("<user_info>")
      ) {
        continue
      }
      const texts: Array<string> = []
      for (const p of parts) {
        if (Option.isSome(p) && p.value.type === "text" && p.value.text) {
          const text = stripUserQuery(p.value.text)
          if (text) texts.push(text)
        }
      }
      const text = texts.length > 0 ? texts.join("\n\n") : null
      b.message({ role: "user", text, nativeMessageId: nativeId })
      continue
    }

    if (role === "assistant") {
      // A Cursor assistant blob holds the whole turn and can genuinely interleave
      // text, reasoning, and tool-calls. Walk parts in source order, flushing
      // accumulated text/thinking as a message chunk whenever a tool-call
      // interrupts it (see assistantTurn), so the shared `ordinal` records true
      // display order.
      const turn = b.assistantTurn({ nativeMessageId: nativeId })

      for (const item of content) {
        const p = decodeCursorPart(item)
        if (Option.isNone(p)) continue
        switch (p.value.type) {
          case "text":
            turn.text(p.value.text)
            break
          case "reasoning":
          case "redacted-reasoning":
            turn.thinking(p.value.text)
            break
          case "tool-call": {
            turn.flush() // emit any text/reasoning that preceded this tool
            const name = p.value.toolName
            const input = obj(p.value.args)
            const row = b.tool({
              name: name ?? null,
              kind: classifyTool("cursor", name),
              nativeToolId: p.value.toolCallId ?? null,
              messageId: turn.messageId,
              inputJson: input ? JSON.stringify(input) : null,
            })
            b.hint(name, input, turn.messageId, row.id)
            break
          }
        }
      }
      turn.flush() // trailing text after the last tool
      continue
    }

    if (role === "tool") {
      for (const item of content) {
        const p = decodeCursorPart(item)
        if (Option.isNone(p) || p.value.type !== "tool-result") continue
        // Built-in Cursor tools store `result` as a string, but MCP tools store
        // the unwrapped structured return value as an object/array. The old
        // `str(result)` coercion silently dropped every object result, leaving
        // MCP calls stuck on "pending" — serialize non-strings so they resolve.
        const result = toolResultText(p.value.result)
        if (p.value.toolCallId && result) b.result(p.value.toolCallId, result)
      }
    }
  }

  return b.finish({
    nativeSessionId: options.nativeSessionId,
    workspaceRoot: options.workspaceRoot,
    sourcePath: options.sourcePath,
    title: options.title,
    createdAt: options.createdAt ?? null,
    rawMetadataJson: options.rawMetadataJson ?? null,
    diagnostics: options.diagnostics,
  })
}

/**
 * Stable signatures for a blob's recoverable content parts (text, reasoning,
 * tool calls, tool results). Used to tell whether an orphaned blob holds
 * anything the connected conversation doesn't already contain. Cursor's usual
 * orphans are superseded *duplicates* of a connected turn, so their signatures
 * all match — and encrypted `redacted-reasoning` parts produce no signature.
 */
const contentSignatures = (blob: Rec): ReadonlyArray<string> => {
  const content = Array.isArray(blob["content"]) ? blob["content"] : []
  const signatures: Array<string> = []
  for (const item of content) {
    const part = obj(item)
    switch (part?.["type"]) {
      case "text":
        if (str(part["text"])) signatures.push(`text:${part["text"]}`)
        break
      case "reasoning":
      case "redacted-reasoning":
        if (str(part["text"])) signatures.push(`reasoning:${part["text"]}`)
        break
      case "tool-call":
        signatures.push(`tool:${str(part["toolName"]) ?? ""}:${JSON.stringify(part["args"] ?? null)}`)
        break
      case "tool-result":
        signatures.push(`result:${str(part["toolCallId"]) ?? ""}`)
        break
    }
  }
  return signatures
}

// ---------------------------------------------------------------------------
// Provider (IO): SQLite read (read-only, snapshot fallback) + blob pipeline.
// ---------------------------------------------------------------------------

interface RawDb {
  readonly metaValue: string | undefined
  readonly blobs: ReadonlyArray<{ rowid: number; id: string; data: Uint8Array }>
}

/** Read meta['0'] and all blobs from a store.db via a per-file read-only client. */
const readVia = (file: string): Effect.Effect<RawDb, SqlError> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const meta = yield* sql<{ value: string }>`SELECT value FROM meta WHERE key = '0'`
    const blobs = yield* sql<{ rowid: number; id: string; data: Uint8Array }>`SELECT rowid, id, data FROM blobs`
    return {
      metaValue: meta[0]?.value,
      blobs: blobs.map((b) => ({ rowid: Number(b.rowid), id: String(b.id), data: b.data })),
    }
  }).pipe(Effect.provide(SqliteClient.layer({ filename: file, readonly: true })))

/** Copy store.db (+ -wal/-shm) to a temp dir and read the snapshot, for live/locked DBs. */
const readViaSnapshot = (dbPath: string): Effect.Effect<RawDb, SqlError> =>
  Effect.acquireUseRelease(
    Effect.sync(() => mkdtempSync(join(tmpdir(), "arc-cursor-"))),
    (dir) => {
      const copy = join(dir, "store.db")
      return Effect.flatMap(
        Effect.sync(() => {
          copyFileSync(dbPath, copy)
          for (const ext of ["-wal", "-shm"]) {
            try {
              copyFileSync(dbPath + ext, copy + ext)
            } catch {
              // -wal/-shm may not exist; the main db copy is enough.
            }
          }
        }),
        () => readVia(copy),
      )
    },
    (dir) => Effect.sync(() => rmSync(dir, { recursive: true, force: true })),
  )

const readDb = (dbPath: string): Effect.Effect<RawDb, CursorReadError> =>
  readVia(dbPath).pipe(
    // A live/locked DB may fail or die on direct read; retry against a snapshot copy.
    Effect.catchCause(() => readViaSnapshot(dbPath)),
    Effect.catchCause((cause) => Effect.fail(new CursorReadError({ path: dbPath, cause }))),
  )

export const makeCursorProvider: Effect.Effect<AgentProvider, never, FileSystem.FileSystem | Path.Path> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    const chatsDirFor = (real: string) =>
      path.join(homedir(), ".cursor", "chats", createHash("md5").update(real).digest("hex"))

    // Each cursor session is its own `store.db`. With a `nativeSessionId` hint we
    // read just that one db (the active session) — the cursor poll fires every
    // 750ms during a turn, and parsing all sessions per tick pegged the main
    // process (61 dbs / 184 MB on a real workspace) to use exactly one. Without
    // the hint we list the session dirs and read each once.
    const collect = (workspace: string, nativeSessionId?: string) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(workspace).pipe(Effect.orElseSucceed(() => workspace))
        const dir = chatsDirFor(real)
        if (!(yield* fs.exists(dir).pipe(Effect.orElseSucceed(() => false)))) return []
        if (nativeSessionId !== undefined) {
          const dbPath = path.join(dir, nativeSessionId, "store.db")
          if (!(yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))) return []
          return [yield* extractOne(real, nativeSessionId, dbPath)]
        }
        const entries = yield* fs
          .readDirectory(dir)
          .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
        const out: Array<ExtractedRows> = []
        for (const sessionId of entries) {
          const dbPath = path.join(dir, sessionId, "store.db")
          if (!(yield* fs.exists(dbPath).pipe(Effect.orElseSucceed(() => false)))) continue
          out.push(yield* extractOne(real, sessionId, dbPath))
        }
        return out
      })

    const extractOne = (
      real: string,
      nativeSessionId: string,
      sourcePath: string,
    ): Effect.Effect<ExtractedRows, IngestError> =>
      Effect.gen(function* () {
        const raw = yield* readDb(sourcePath)

        const meta = raw.metaValue ? parseJson(Buffer.from(raw.metaValue, "hex").toString("utf8")) : undefined
        const createdAtMs = typeof meta?.["createdAt"] === "number" ? (meta["createdAt"] as number) : undefined
        const createdAt = createdAtMs ? new Date(createdAtMs).toISOString() : undefined
        const name = str(meta?.["name"])
        const endBlobId = str(meta?.["latestRootBlobId"])

        const cursorBlobs: Array<CursorBlob> = []
        for (const b of raw.blobs) {
          const json = extractJsonFromBinary(b.data)
          if (json === null) continue
          cursorBlobs.push({ rowid: b.rowid, id: b.id, json, refs: parseReferences(b.data) })
        }
        const { sorted, orphaned } = topologicalSort(cursorBlobs, endBlobId)
        const orderedJson = sorted
          .map((b) => parseJson(b.json))
          .filter((o): o is Rec => o !== undefined)

        // Only warn about orphans carrying content the connected conversation
        // does NOT already contain. Cursor's orphans are normally superseded
        // duplicates of a connected turn (same text/tools), so this is usually 0.
        const connectedSignatures = new Set(orderedJson.flatMap((b) => contentSignatures(b)))
        const lostBlobs = orphaned.filter((b) => {
          const parsed = parseJson(b.json)
          return parsed !== undefined && contentSignatures(parsed).some((s) => !connectedSignatures.has(s))
        })
        const diagnostics: Array<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">> = []
        if (lostBlobs.length > 0) {
          diagnostics.push({
            severity: "warning",
            code: "orphaned_blobs",
            message: `${lostBlobs.length} orphaned blob(s) hold content missing from the extracted conversation`,
            sourcePath,
          })
        }

        return normalizeCursorBlobs(orderedJson, {
          nativeSessionId,
          sourcePath,
          workspaceRoot: real,
          ...(name ? { title: name } : {}),
          ...(createdAt ? { createdAt } : {}),
          ...(raw.metaValue ? { rawMetadataJson: Buffer.from(raw.metaValue, "hex").toString("utf8") } : {}),
          diagnostics,
        })
      })

    return { id: "cursor", collect } satisfies AgentProvider
  })
