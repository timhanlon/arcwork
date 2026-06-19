import { Effect, FileSystem, Option, Path, Schema } from "effect"
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
const arr = (v: unknown): ReadonlyArray<unknown> | undefined => (Array.isArray(v) ? v : undefined)
const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

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
// Pure JSONL -> session pipeline (ported from SpecStory's claudecode parser).
// Claude's JSONL is an append-only event log, not a clean transcript: records
// must be deduped, linked into parent/child DAGs, merged across resumed
// sessions, and flattened by timestamp.
// ---------------------------------------------------------------------------

/**
 * Per-file pre-pass: a sidechain (subagent) record with no parent is re-parented
 * to the prior record so it stays attached to the conversation it branched from.
 */
export const rewriteSidechains = (records: ReadonlyArray<Rec>): ReadonlyArray<Rec> => {
  let lastUuid: string | undefined
  return records.map((r) => {
    let rec = r
    if (r["isSidechain"] === true && (r["parentUuid"] === null || r["parentUuid"] === undefined) && lastUuid) {
      rec = { ...r, parentUuid: lastUuid }
    }
    const uuid = str(r["uuid"])
    if (uuid) lastUuid = uuid
    return rec
  })
}

/** Dedup by uuid (keep earliest timestamp), drop records without a uuid, sort by timestamp. */
export const dedupeByUuid = (records: ReadonlyArray<Rec>): ReadonlyArray<Rec> => {
  const byUuid = new Map<string, Rec>()
  for (const r of records) {
    const uuid = str(r["uuid"])
    if (!uuid) continue
    const existing = byUuid.get(uuid)
    if (!existing) {
      byUuid.set(uuid, r)
    } else if ((str(r["timestamp"]) ?? "") < (str(existing["timestamp"]) ?? "")) {
      byUuid.set(uuid, r)
    }
  }
  return [...byUuid.values()].sort((a, b) => cmpStr(str(a["timestamp"]) ?? "", str(b["timestamp"]) ?? ""))
}

/** Build a parent/child DAG for each root (parentUuid == null/absent). */
export const buildDags = (records: ReadonlyArray<Rec>): ReadonlyArray<ReadonlyArray<Rec>> => {
  const byUuid = new Map<string, Rec>()
  const childrenOf = new Map<string, Array<Rec>>()
  for (const r of records) {
    const uuid = str(r["uuid"])
    if (uuid) byUuid.set(uuid, r)
  }
  for (const r of records) {
    const parent = str(r["parentUuid"])
    if (parent) {
      const list = childrenOf.get(parent) ?? []
      list.push(r)
      childrenOf.set(parent, list)
    }
  }

  const dags: Array<Array<Rec>> = []
  for (const root of records) {
    if (root["parentUuid"] !== null && root["parentUuid"] !== undefined) continue
    const dag: Array<Rec> = []
    const visited = new Set<string>()
    const traverse = (node: Rec): void => {
      const uuid = str(node["uuid"])
      if (!uuid || visited.has(uuid)) return
      visited.add(uuid)
      dag.push(node)
      const children = (childrenOf.get(uuid) ?? [])
        .filter((c) => {
          const cu = str(c["uuid"])
          return cu !== undefined && byUuid.has(cu)
        })
        .sort((a, b) => cmpStr(str(a["timestamp"]) ?? "", str(b["timestamp"]) ?? ""))
      for (const child of children) traverse(child)
    }
    traverse(root)
    if (dag.length > 0) dags.push(dag)
  }
  return dags
}

/** Merge DAGs that share a sessionId (resumed sessions fragment across roots/files). */
export const mergeBySessionId = (
  dags: ReadonlyArray<ReadonlyArray<Rec>>,
): ReadonlyArray<ReadonlyArray<Rec>> => {
  const groups = new Map<string, Array<ReadonlyArray<Rec>>>()
  let anon = 0
  for (const dag of dags) {
    if (dag.length === 0) continue
    let sessionId: string | undefined
    for (const r of dag) {
      const s = str(r["sessionId"])
      if (s) {
        sessionId = s
        break
      }
    }
    const key = sessionId ?? `no-session-${anon++}`
    const group = groups.get(key) ?? []
    group.push(dag)
    groups.set(key, group)
  }
  const merged: Array<ReadonlyArray<Rec>> = []
  for (const group of groups.values()) {
    merged.push(group.length === 1 ? group[0]! : group.flat())
  }
  return merged
}

/** Flatten a DAG to timestamp order, using parent/child then uuid as tiebreakers. */
export const flattenDag = (dag: ReadonlyArray<Rec>): ReadonlyArray<Rec> =>
  [...dag].sort((a, b) => {
    const ta = str(a["timestamp"]) ?? ""
    const tb = str(b["timestamp"]) ?? ""
    if (ta !== tb) return ta < tb ? -1 : 1
    const ua = str(a["uuid"]) ?? ""
    const ub = str(b["uuid"]) ?? ""
    if (str(a["parentUuid"]) === ub) return 1
    if (str(b["parentUuid"]) === ua) return -1
    return cmpStr(ua, ub)
  })

export interface ClaudeSession {
  readonly sessionId: string
  readonly records: ReadonlyArray<Rec>
}

/** Run the full dedup -> DAG -> merge -> flatten pipeline over all project files. */
export const parseClaudeSessions = (
  perFile: ReadonlyArray<ReadonlyArray<Rec>>,
): ReadonlyArray<ClaudeSession> => {
  const all: Array<Rec> = []
  for (const records of perFile) all.push(...rewriteSidechains(records))
  const merged = mergeBySessionId(buildDags(dedupeByUuid(all)))
  const sessions: Array<ClaudeSession> = []
  for (const dag of merged) {
    const flat = flattenDag(dag)
    if (flat.length === 0) continue
    let sessionId: string | undefined
    for (const r of flat) {
      const s = str(r["sessionId"])
      if (s) {
        sessionId = s
        break
      }
    }
    if (!sessionId) continue
    sessions.push({ sessionId, records: flat })
  }
  return sessions
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
  const list = arr(content)
  if (!list) return ""
  const parts: Array<string> = []
  for (const item of list) {
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

  for (const record of session.records) {
    const type = str(record["type"])
    const timestamp = str(record["timestamp"]) ?? null
    b.observeTimestamp(timestamp)
    const message = obj(record["message"])
    const uuid = str(record["uuid"]) ?? null

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
      const contentArray = arr(content)
      const isToolResult =
        contentArray !== undefined && obj(contentArray[0])?.["type"] === "tool_result"

      if (isToolResult) {
        // AskUserQuestion's chosen-answer map lives in the structured
        // `toolUseResult` sidecar on the record, not the human-readable
        // `content` sentence that becomes `outputText`. Capture it so the
        // artifact projection can lift the selected option onto its question
        // (the live hook path gets the same data from `tool_response`).
        const sidecar = obj(record["toolUseResult"])
        for (const item of contentArray!) {
          const part = obj(item)
          if (part?.["type"] !== "tool_result") continue
          const useId = str(part["tool_use_id"])
          if (!useId) continue
          const isError = part["is_error"] === true
          const text = toolResultText(part["content"])
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
      if (text === undefined && contentArray) {
        const parts: Array<string> = []
        for (const item of contentArray) {
          const part = obj(item)
          if (part?.["type"] === "text") {
            const t = str(part["text"])
            if (t) parts.push(t)
          }
        }
        text = parts.length > 0 ? parts.join("\n\n") : undefined
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
      const contentArray = arr(message?.["content"]) ?? []
      const model = str(message?.["model"]) ?? null

      // Walk content parts in source order, flushing accumulated text/thinking as
      // a message chunk whenever a tool_use interrupts it. This records the true
      // `text → tool → text` display order in the shared `ordinal`. Claude almost
      // always emits thinking+text *before* any tools (one chunk), so the flush
      // only ever splits the rare interleaved turn; the common case is unchanged.
      let pendingText: Array<string> = []
      let pendingThinking: Array<string> = []
      let turnMessageId: string | null = null

      const flushMessage = (): void => {
        if (pendingText.length === 0 && pendingThinking.length === 0) return
        turnMessageId = b.message({
          role: "assistant",
          model,
          createdAt: timestamp,
          nativeMessageId: uuid,
          text: pendingText.length > 0 ? pendingText.join("\n\n") : null,
          thinking: pendingThinking.length > 0 ? pendingThinking.join("\n\n") : null,
        })
        pendingText = []
        pendingThinking = []
      }

      for (const item of contentArray) {
        const part = obj(item)
        if (!part) continue
        switch (part["type"]) {
          case "text": {
            const t = str(part["text"])
            if (t) pendingText.push(t)
            break
          }
          case "thinking": {
            const t = str(part["thinking"])
            if (t) pendingThinking.push(t)
            break
          }
          case "tool_use": {
            flushMessage() // emit any text/thinking that preceded this tool
            const name = str(part["name"])
            const useId = str(part["id"])
            const input = obj(part["input"])
            const row = b.tool({
              name: name ?? null,
              kind: classifyTool("claude", name),
              nativeToolId: useId ?? null,
              messageId: turnMessageId,
              inputJson: input ? JSON.stringify(input) : null,
            })
            b.hint(name, input, turnMessageId, row.id)
            break
          }
        }
      }
      flushMessage() // trailing text after the last tool
    }
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
