import { Effect, FileSystem, Path } from "effect"
import type { DiagnosticRow, ExtractedRows, Provider as ProviderId } from "../db/schema.js"
import type { Rec } from "../extract/json.js"
import type { AgentProvider } from "./provider.js"
import { readFirstLine, readJsonl } from "./jsonl.js"

/**
 * Codex and pi are both flat JSONL session stores: one `.jsonl` file per session
 * under a provider root, the first line a header carrying the native session id +
 * cwd, the rest a chronological event stream. Their discovery is identical —
 * recursively scan the root, sniff each file's header, match the workspace cwd,
 * then read+normalize each match — differing only in the root path, how the
 * header line maps to a {id, cwd}, and the per-record normalize. This factory
 * owns the shared scan/collect/diagnostics machinery; a provider supplies the
 * three differences. (Claude and cursor don't fit: claude keys sessions to a
 * hashed project dir, cursor stores each session in its own SQLite db.)
 */

export interface JsonlSessionRef {
  readonly path: string
  readonly nativeSessionId: string
  readonly cwd: string
}

export interface JsonlNormalizeOptions {
  readonly nativeSessionId: string
  readonly sourcePath: string
  readonly workspaceRoot: string
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

export interface JsonlProviderConfig {
  readonly id: ProviderId
  /** Provider session root, e.g. `~/.codex/sessions`. */
  readonly root: (path: Path.Path) => string
  /** Map a sniffed header line to {id, cwd}; `undefined` skips the file. */
  readonly readMeta: (firstLine: string) => Omit<JsonlSessionRef, "path"> | undefined
  readonly normalize: (records: ReadonlyArray<Rec>, options: JsonlNormalizeOptions) => ExtractedRows
}

export const makeJsonlSessionProvider = (
  config: JsonlProviderConfig,
): Effect.Effect<AgentProvider, never, FileSystem.FileSystem | Path.Path> =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const root = config.root(path)

    /** Every session file under the root, paired with its sniffed header meta. */
    const scan = Effect.gen(function* () {
      if (!(yield* fs.exists(root).pipe(Effect.orElseSucceed(() => false)))) {
        return [] as ReadonlyArray<JsonlSessionRef>
      }
      const entries = yield* fs
        .readDirectory(root, { recursive: true })
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
      const files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(root, name))

      const metas: Array<JsonlSessionRef> = []
      for (const file of files) {
        const line = yield* readFirstLine(fs, file)
        if (line.length === 0) continue
        const meta = config.readMeta(line)
        if (!meta) continue
        metas.push({ path: file, ...meta })
      }
      return metas
    })

    // Scan headers once (one line per file — cheap), then read+normalize each
    // matching file. A full collect is already O(transcript): each file is one
    // session. When a `nativeSessionId` hint is given (the turn-end re-ingest
    // path), narrow to the single file carrying that id before the expensive
    // `readJsonl` — the header scan already knows every file's id, so only the
    // changed session is parsed instead of every rollout sharing the workspace
    // cwd (the O(sessions × transcript) blow-up the claude/cursor providers were
    // fixed to avoid). Callers still filter the result, so the hint stays a cost
    // optimization, never a correctness requirement.
    const collect = (workspace: string, nativeSessionId?: string) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(workspace).pipe(Effect.orElseSucceed(() => workspace))
        const metas = yield* scan
        const matched = metas.filter(
          (m) =>
            (m.cwd === real || m.cwd === workspace) &&
            (nativeSessionId === undefined || m.nativeSessionId === nativeSessionId),
        )
        const out: Array<ExtractedRows> = []
        for (const m of matched) {
          const result = yield* readJsonl(fs, config.id, m.path)
          out.push(
            config.normalize(result.records, {
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

    return { id: config.id, collect } satisfies AgentProvider
  })
