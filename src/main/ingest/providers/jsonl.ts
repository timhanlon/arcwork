import { Effect, type FileSystem } from "effect"
import { ArtifactReadError } from "../errors.js"

/**
 * 250MB per-file sanity cap. Claude transcripts embed large tool outputs; this
 * guards against pathological/corrupt files without a token-size limit on
 * individual lines (we read the whole file, not a fixed-size scanner buffer).
 */
const MAX_FILE_BYTES = 250 * 1024 * 1024

export interface JsonlParseError {
  readonly line: number
  readonly message: string
}

export interface JsonlResult {
  /** Parsed top-level JSON objects, in file order. */
  readonly records: ReadonlyArray<Record<string, unknown>>
  /** Lines that failed to parse — kept so the caller can record diagnostics. */
  readonly parseErrors: ReadonlyArray<JsonlParseError>
}

/**
 * Read a JSONL file into parsed objects. Corrupt lines are collected as
 * `parseErrors` rather than failing the read, so partial extraction succeeds
 * (the file-level read still fails on missing/oversized/unreadable files).
 */
export const readJsonl = (
  fs: FileSystem.FileSystem,
  provider: string,
  path: string,
): Effect.Effect<JsonlResult, ArtifactReadError> =>
  Effect.gen(function* () {
    const info = yield* fs
      .stat(path)
      .pipe(Effect.mapError((cause) => new ArtifactReadError({ provider, path, cause })))

    if (Number(info.size) > MAX_FILE_BYTES) {
      return yield* Effect.fail(
        new ArtifactReadError({
          provider,
          path,
          cause: `file exceeds ${MAX_FILE_BYTES} byte sanity cap`,
        }),
      )
    }

    const content = yield* fs
      .readFileString(path)
      .pipe(Effect.mapError((cause) => new ArtifactReadError({ provider, path, cause })))

    const records: Array<Record<string, unknown>> = []
    const parseErrors: Array<JsonlParseError> = []
    const lines = content.split("\n")
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!.trim()
      if (line.length === 0) continue
      try {
        const parsed: unknown = JSON.parse(line)
        if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
          records.push(parsed as Record<string, unknown>)
        } else {
          parseErrors.push({ line: i + 1, message: "line is not a JSON object" })
        }
      } catch (error) {
        parseErrors.push({ line: i + 1, message: String(error) })
      }
    }

    return { records, parseErrors }
  })

/**
 * Read just the first line of a file without loading the whole thing — used to
 * sniff a JSONL session header (Codex `session_meta`, pi `session`). Any read
 * failure collapses to `""`, which callers treat as "no header, skip".
 */
export const readFirstLine = (fs: FileSystem.FileSystem, path: string): Effect.Effect<string> =>
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
