import { Effect, FileSystem, Option, Path, Schema } from "effect"
import { homedir } from "node:os"
import type { DiagnosticRow, ExtractedRows } from "../db/schema.js"
import type { IngestError } from "../errors.js"
import { classifyTool } from "../extract/tool-kind.js"
import { SessionRowBuilder } from "../extract/session-row-builder.js"
import { readJsonl } from "./jsonl.js"
import type { AgentProvider } from "./provider.js"
import { type ClaudeSession, parseClaudeSessions } from "./claude-dag.js"
import { type Rec, arr, obj, str } from "../extract/json.js"

const skillBaseDirectoryPrefix = "Base directory for this skill:"

/**
 * Claude records skill loads as `isMeta` user rows. The payload can include the
 * whole SKILL.md body, which is internal instruction context and overwhelms the
 * chat transcript if projected verbatim.
 */
const displayTextForMetaPrompt = (text: string | undefined): string | undefined => {
  if (!text?.startsWith(skillBaseDirectoryPrefix)) return text
  const firstLine = text.split(/\r?\n/, 1)[0] ?? text
  const skillPath = firstLine.slice(skillBaseDirectoryPrefix.length).trim()
  const skillName = skillPath.split(/[\\/]/).findLast(Boolean)
  return skillName ? `Read skill: ${skillName}` : "Read skill"
}

const commandNameRe = /<command-name>([\s\S]*?)<\/command-name>/
const commandArgsRe = /<command-args>([\s\S]*?)<\/command-args>/

/**
 * A typed slash command is recorded as a user prompt wrapped in harness tags,
 * e.g. `<command-message>commit</command-message><command-name>/commit</command-name><command-args>before fixes</command-args>`.
 * Projecting that verbatim both shows the raw tags and fails to reconcile with
 * the composer's optimistic echo (which holds the clean `/commit before fixes`
 * the user actually typed), leaving a duplicate bubble. Collapse it back to that
 * command line — `/<name>` plus any args — so the body matches the echo.
 */
const displayTextForUserPrompt = (text: string | undefined): string | undefined => {
  if (text === undefined) return text
  const name = commandNameRe.exec(text)?.[1]?.trim()
  if (!name) return text
  const args = commandArgsRe.exec(text)?.[1]?.trim()
  return args ? `${name} ${args}` : name
}

// ---------------------------------------------------------------------------
// Normalize one flattened session into database rows.
// ---------------------------------------------------------------------------

// A tool_result's `content` is either a plain string or an array of typed
// blocks. The block shapes are modeled as schemas so each flattens to a textual
// representation deterministically: a bare `{text}` reader silently dropped
// `tool_reference` (ToolSearch) and `image` results, projecting those tools as
// output-less/pending forever even though the transcript carried a result.
const TextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
const ToolReferenceBlock = Schema.Struct({ type: Schema.Literal("tool_reference"), tool_name: Schema.String })
const ImageBlock = Schema.Struct({ type: Schema.Literal("image") })
const ToolResultBlock = Schema.Union([TextBlock, ToolReferenceBlock, ImageBlock])
const decodeToolResultBlock = Schema.decodeUnknownOption(ToolResultBlock)

const toolResultBlockText = (block: typeof ToolResultBlock.Type): string => {
  switch (block.type) {
    case "text":
      return block.text
    case "tool_reference":
      return `→ ${block.tool_name}`
    case "image":
      return "[image]"
  }
}

/** Collapse a tool_result's content (string or array of typed blocks) to a string. */
const toolResultText = (content: unknown): string => {
  const s = str(content)
  if (s !== undefined) return s
  const parts: Array<string> = []
  for (const item of arr(content)) {
    const block = decodeToolResultBlock(item)
    // Unknown block shapes decode to None and are skipped rather than emitting
    // an empty string; add a schema member above to capture a new shape.
    if (Option.isSome(block)) {
      const text = toolResultBlockText(block.value)
      if (text) parts.push(text)
    }
  }
  return parts.join("\n")
}

const NeStr = Schema.NonEmptyString

const Usage = Schema.Struct({
  input_tokens: Schema.optional(Schema.Number),
  cache_read_input_tokens: Schema.optional(Schema.Number),
  cache_creation_input_tokens: Schema.optional(Schema.Number),
  output_tokens: Schema.optional(Schema.Number),
})
const decodeUsage = Schema.decodeUnknownOption(Usage)

// A message's top-level content parts, discriminated by `type` (distinct from the
// tool_result *inner* blocks above). Decoding each part replaces the per-part
// `obj` + `switch (part["type"])` + `str(part["…"])` plucking; an unknown or
// malformed part decodes to None and is skipped, as the old default case did.
// `text`/`thinking` are optional NonEmpty (pushed only `if (str(...))`); `tool_use`
// keeps `name` optional (the old code kept a null-named call as `name ?? null`).
const ContentPart = Schema.Union([
  Schema.Struct({ type: Schema.Literal("text"), text: Schema.optional(NeStr) }),
  Schema.Struct({ type: Schema.Literal("thinking"), thinking: Schema.optional(NeStr) }),
  Schema.Struct({
    type: Schema.Literal("tool_use"),
    name: Schema.optional(NeStr),
    id: Schema.optional(NeStr),
    input: Schema.optional(Schema.Unknown),
  }),
  Schema.Struct({
    type: Schema.Literal("tool_result"),
    tool_use_id: Schema.optional(NeStr),
    is_error: Schema.optional(Schema.Boolean),
    content: Schema.optional(Schema.Unknown),
  }),
])
const decodeContentPart = Schema.decodeUnknownOption(ContentPart)

const finite = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value

/**
 * Model name Claude Code stamps on the assistant records it fabricates for API
 * errors, interrupts, and other non-turn notices. These carry an all-zero
 * `usage` object with no `requestId`; treating that as real usage would land a
 * `contextUsedTokens: 0` row at the error point, so a context meter reading the
 * latest usage after an API error would read 0. Their usage is skipped.
 */
const SYNTHETIC_MODEL = "<synthetic>"

interface ClaudeUsageDraft {
  readonly occurredAt: string | null
  readonly nativeRequestId: string | null
  readonly model: string | null
  readonly contextUsedTokens: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly rawJson: string
}

export interface NormalizeOptions {
  readonly workspaceRoot: string
  readonly sourcePath: string
  readonly title?: string
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

export const normalizeClaudeSession = (
  session: ClaudeSession,
  options: NormalizeOptions,
): ExtractedRows => {
  const b = new SessionRowBuilder("claude", session.sessionId)
  const usageByRequest = new Map<string, ClaudeUsageDraft>()

  for (const record of session.records) {
    const type = str(record["type"])
    const timestamp = str(record["timestamp"]) ?? null
    b.observeTimestamp(timestamp)
    const message = obj(record["message"])
    const uuid = str(record["uuid"]) ?? null
    const requestId = str(record["requestId"])

    if (type === "assistant" && message) {
      const model = str(message["model"]) ?? null
      const decodedUsage = model === SYNTHETIC_MODEL ? Option.none() : decodeUsage(message["usage"])
      if (Option.isSome(decodedUsage)) {
        const usage = decodedUsage.value
        const inputTokens = finite(usage.input_tokens)
        const cachedInputTokens = finite(usage.cache_read_input_tokens)
        const cacheCreationInputTokens = finite(usage.cache_creation_input_tokens)
        const outputTokens = finite(usage.output_tokens)
        const contextUsedTokens =
          inputTokens === null && cachedInputTokens === null && cacheCreationInputTokens === null
            ? null
            : (inputTokens ?? 0) + (cachedInputTokens ?? 0) + (cacheCreationInputTokens ?? 0)
        usageByRequest.set(requestId ?? `${uuid ?? "assistant"}:${timestamp ?? usageByRequest.size}`, {
          occurredAt: timestamp,
          nativeRequestId: requestId ?? null,
          model,
          contextUsedTokens,
          inputTokens,
          outputTokens,
          rawJson: JSON.stringify(message["usage"]),
        })
      }
    }

    // Return-from-away recap: Claude writes a `system`/`away_summary` record
    // (isSidechain:false) whose top-level `content` is the "here's where we left
    // off" Goal/Next summary. It is neither a user nor an assistant turn, so it
    // would otherwise fall through unhandled. Emit it as a distinct `recap` row
    // (see ChatMessage's recap role) so the chat pane can surface it as a
    // first-class "picking up where you left off" card rather than dropping it
    // or — via the hook path — mislabelling it as a subagent message.
    if (type === "system" && str(record["subtype"]) === "away_summary") {
      const content = str(record["content"])
      if (content) b.message({ role: "recap", text: content, createdAt: timestamp, nativeMessageId: uuid })
      continue
    }

    if (type === "user") {
      const content = message?.["content"]
      const parts = arr(content).map((item) => decodeContentPart(item))
      const first = parts[0]
      const isToolResult = first !== undefined && Option.isSome(first) && first.value.type === "tool_result"

      if (isToolResult) {
        // AskUserQuestion's chosen-answer map lives in the structured
        // `toolUseResult` sidecar on the record, not the human-readable
        // `content` sentence that becomes `outputText`. Capture it so the
        // artifact projection can lift the selected option onto its question
        // (the live hook path gets the same data from `tool_response`).
        const sidecar = obj(record["toolUseResult"])
        for (const p of parts) {
          if (Option.isNone(p) || p.value.type !== "tool_result") continue
          const useId = p.value.tool_use_id
          if (!useId) continue
          const isError = p.value.is_error === true
          const text = toolResultText(p.value.content)
          const call = b.result(useId, isError ? `[error] ${text}` : text)
          if (!call) continue
          // Scoped to the question tool: every other tool also carries a
          // sidecar (Bash stdout, file contents, …) and duplicating those into
          // the row would bloat storage for no projection benefit.
          if (call.name === "AskUserQuestion" && sidecar) call.rawJson = JSON.stringify(sidecar)
        }
        continue
      }

      // A new user prompt.
      let text = str(content)
      if (text === undefined) {
        const texts: Array<string> = []
        for (const p of parts) {
          if (Option.isSome(p) && p.value.type === "text" && p.value.text) texts.push(p.value.text)
        }
        text = texts.length > 0 ? texts.join("\n\n") : undefined
      }

      // Programmatic prompts — a ScheduleWakeup/`/loop` self-pace re-submission or
      // a skill base-directory injection — are replayed through the normal user
      // path but flagged `isMeta: true` in the transcript. They are not something
      // the human typed, so project them as a distinct `meta` role (muted card)
      // rather than a user turn, and keep them out of the title seed. The live
      // hook payload has no `isMeta`, so the hook path can't tell these apart and
      // records a user row; ChatMessageService relabels that row to `meta` on
      // artifact re-ingest (see projectArtifactSession). `meta` role keeps these
      // out of the title seed (the builder only seeds from `user` rows).
      const isMeta = record["isMeta"] === true
      if (!isMeta) text = displayTextForUserPrompt(text)
      const displayText = isMeta ? displayTextForMetaPrompt(text) : text
      b.message({
        role: isMeta ? "meta" : "user",
        text: displayText ?? null,
        createdAt: timestamp,
        nativeMessageId: uuid,
      })
      continue
    }

    if (type === "assistant") {
      const contentArray = arr(message?.["content"])
      const model = str(message?.["model"]) ?? null

      // Walk content parts in source order, flushing accumulated text/thinking as
      // a message chunk whenever a tool_use interrupts it (see assistantTurn).
      // Claude almost always emits thinking+text *before* any tools (one chunk),
      // so the flush only ever splits the rare interleaved turn.
      const turn = b.assistantTurn({ model, createdAt: timestamp, nativeMessageId: uuid })

      for (const item of contentArray) {
        const p = decodeContentPart(item)
        if (Option.isNone(p)) continue
        switch (p.value.type) {
          case "text":
            turn.text(p.value.text)
            break
          case "thinking":
            turn.thinking(p.value.thinking)
            break
          case "tool_use": {
            turn.flush() // emit any text/thinking that preceded this tool
            const name = p.value.name
            const input = obj(p.value.input)
            const row = b.tool({
              name: name ?? null,
              kind: classifyTool("claude", name),
              nativeToolId: p.value.id ?? null,
              messageId: turn.messageId,
              inputJson: input ? JSON.stringify(input) : null,
            })
            b.hint(name, input, turn.messageId, row.id)
            break
          }
        }
      }
      turn.flush() // trailing text after the last tool
    }
  }

  for (const usage of usageByRequest.values()) {
    b.usage(usage)
  }

  return b.finish({
    nativeSessionId: session.sessionId,
    workspaceRoot: options.workspaceRoot,
    sourcePath: options.sourcePath,
    title: options.title,
    diagnostics: options.diagnostics,
  })
}

// ---------------------------------------------------------------------------
// Provider (IO): resolve the project dir, read files, parse, normalize.
// ---------------------------------------------------------------------------

/** Claude derives a project dir name by replacing non [A-Za-z0-9-] chars with `-`. */
export const claudeProjectDirName = (realWorkspacePath: string): string => {
  const dashed = realWorkspacePath.replace(/[^a-zA-Z0-9-]/g, "-")
  return dashed.startsWith("-") ? dashed : `-${dashed}`
}

interface LoadedProject {
  readonly projectDir: string
  readonly sessions: ReadonlyArray<ClaudeSession>
  readonly titleBySession: ReadonlyMap<string, string>
  readonly parseErrorsByBase: ReadonlyMap<string, ReadonlyArray<{ line: number; message: string; path: string }>>
}

const loadProject = (
  fs: FileSystem.FileSystem,
  path: Path.Path,
  workspace: string,
  nativeSessionId?: string,
): Effect.Effect<LoadedProject | undefined, IngestError> =>
  Effect.gen(function* () {
    const real = yield* fs.realPath(workspace).pipe(Effect.orElseSucceed(() => workspace))
    const projectDir = path.join(homedir(), ".claude", "projects", claudeProjectDirName(real))
    if (!(yield* fs.exists(projectDir).pipe(Effect.orElseSucceed(() => false)))) return undefined

    // Claude writes one self-contained `<sessionId>.jsonl` per session (verified:
    // every record in a file carries that file's basename as its `sessionId`).
    // So when a caller names a session — the transcript-watch path, fired because
    // exactly that file changed — read only it instead of re-parsing the whole
    // project dir (hundreds of files / hundreds of MB) to keep a few new rows.
    // Falls back to the full scan when the named file is absent or no id is given
    // (startup reconcile / filter="all"). The cross-file `mergeBySessionId` merge
    // stays correct: it just operates over the one file's records.
    const scopedFile =
      nativeSessionId !== undefined ? path.join(projectDir, `${nativeSessionId}.jsonl`) : undefined
    let files: ReadonlyArray<string>
    if (scopedFile !== undefined && (yield* fs.exists(scopedFile).pipe(Effect.orElseSucceed(() => false)))) {
      files = [scopedFile]
    } else {
      const entries = yield* fs
        .readDirectory(projectDir)
        .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>))
      files = entries.filter((name) => name.endsWith(".jsonl")).map((name) => path.join(projectDir, name))
    }

    const perFile: Array<ReadonlyArray<Rec>> = []
    const titleBySession = new Map<string, string>()
    const parseErrorsByBase = new Map<string, Array<{ line: number; message: string; path: string }>>()

    for (const file of files) {
      const result = yield* readJsonl(fs, "claude", file)
      perFile.push(result.records)
      const base = path.basename(file, ".jsonl")
      if (result.parseErrors.length > 0) {
        parseErrorsByBase.set(
          base,
          result.parseErrors.map((e) => ({ line: e.line, message: e.message, path: file })),
        )
      }
      for (const r of result.records) {
        const sid = str(r["sessionId"])
        if (!sid) continue
        if (r["type"] === "ai-title") {
          const t = str(r["aiTitle"])
          if (t) titleBySession.set(sid, t)
        } else if (r["type"] === "summary" && !titleBySession.has(sid)) {
          const t = str(r["summary"])
          if (t) titleBySession.set(sid, t)
        }
      }
    }

    return { projectDir, sessions: parseClaudeSessions(perFile), titleBySession, parseErrorsByBase }
  })

const diagnosticsForSession = (
  session: ClaudeSession,
  parseErrorsByBase: LoadedProject["parseErrorsByBase"],
): ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">> => {
  const bases = new Set<string>()
  for (const r of session.records) {
    const sid = str(r["sessionId"])
    if (sid) bases.add(sid)
  }
  const out: Array<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">> = []
  for (const base of bases) {
    for (const e of parseErrorsByBase.get(base) ?? []) {
      out.push({
        severity: "warning",
        code: "corrupt_jsonl_line",
        message: `line ${e.line}: ${e.message}`,
        sourcePath: e.path,
      })
    }
  }
  return out
}

export const makeClaudeProvider: Effect.Effect<AgentProvider, never, FileSystem.FileSystem | Path.Path> =
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path

    // One `loadProject` parses the named session's file (transcript-watch path)
    // or the whole project dir (startup / filter="all"); every session is then
    // normalized from that single in-memory parse. The old shape ran `loadProject`
    // again inside a per-session `extract`, re-reading the whole directory once
    // per session (O(sessions × transcript)).
    const collect = (workspace: string, nativeSessionId?: string) =>
      Effect.gen(function* () {
        const real = yield* fs.realPath(workspace).pipe(Effect.orElseSucceed(() => workspace))
        const project = yield* loadProject(fs, path, workspace, nativeSessionId)
        if (!project) return []
        return project.sessions.map((session) =>
          normalizeClaudeSession(session, {
            workspaceRoot: real,
            sourcePath: project.projectDir,
            ...(project.titleBySession.get(session.sessionId)
              ? { title: project.titleBySession.get(session.sessionId)! }
              : {}),
            diagnostics: diagnosticsForSession(session, project.parseErrorsByBase),
          }),
        )
      })

    return { id: "claude", collect } satisfies AgentProvider
  })
