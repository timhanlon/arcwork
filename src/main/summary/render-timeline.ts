/**
 * Render a chat's `chat_messages` timeline into a deterministic, condensed text
 * for the summary distiller. Pure (no I/O): given the rows, the output is a
 * function of the input only, so the same chat always hashes to the same
 * `inputHash` and the distiller's idempotency key is stable.
 *
 * The per-role caps and skip rules below were tuned so a small local model gets
 * enough of each turn to summarize without being buried: user intent survives in
 * full-ish (2k), assistant reasoning is trimmed to its lede (900), and tool calls
 * collapse to a single name + truncated in/out line.
 */

/** The subset of a chat-message row the renderer reads (a `ChatMessageRow` is
 * assignable). */
export interface TimelineRow {
  readonly role: string
  readonly body: string
}

export interface TimelineCaps {
  readonly user: number
  readonly assistant: number
  readonly toolInput: number
  readonly toolOutput: number
}

export const DEFAULT_TIMELINE_CAPS: TimelineCaps = {
  user: 2000,
  assistant: 900,
  toolInput: 120,
  toolOutput: 120,
}

export interface RenderTimelineOptions {
  /** Soft ceiling on the whole rendered text. When the default caps overflow it,
   * every per-role cap is scaled down proportionally (never dropping whole turns)
   * until the text fits or the caps hit their floor. Omit for no ceiling. */
  readonly charBudget?: number
  readonly caps?: TimelineCaps
}

// Caps never shrink below this under budget pressure — past it the truncation
// destroys more meaning than it saves space, so the text is left over-budget
// (graceful degradation, not a cliff).
const CAP_FLOOR: TimelineCaps = { user: 300, assistant: 200, toolInput: 40, toolOutput: 40 }

// Roles that never enter the timeline: `recap`/`meta` are the agent's own
// away-summaries (output, not input), and `request` rows are pending-question
// scaffolding, not conversation.
const SKIP_ROLES = new Set(["recap", "meta", "request"])

// Load-bearing tokens that must survive truncation intact: arc TypeIDs (a cut
// mid-suffix yields a different, wrong id) and file paths. `work_rev`/`work_edge`
// precede `work` so the alternation matches the longer prefix first.
const ARC_ID = /(?:work_rev|work_edge|work|chat|target|message|comment)_[0-9a-hjkmnp-tv-z]{2,}/g
// A path-like token: a run of segments joined by `/` (absolute, `~/`, `./`, or
// bare relative like `src/main/x.ts`), so at least one separator is required.
const FILE_PATH = /(?:[~.]{0,2}\/)?[\w.-]+(?:\/[\w.-]+)+/g

interface Span {
  readonly start: number
  readonly end: number
  readonly text: string
}

const protectedSpans = (s: string): ReadonlyArray<Span> => {
  const spans: Array<Span> = []
  for (const re of [ARC_ID, FILE_PATH]) {
    re.lastIndex = 0
    let m: RegExpExecArray | null
    while ((m = re.exec(s)) !== null) {
      spans.push({ start: m.index, end: m.index + m[0].length, text: m[0] })
    }
  }
  return spans.sort((a, b) => a.start - b.start)
}

const collapse = (s: string): string => s.replace(/\s+/g, " ").trim()

/**
 * Truncate `s` to about `limit` chars without splitting a protected token: if the
 * cut lands inside an arc id or path, it extends to that token's end. Any id/path
 * that falls entirely into the dropped tail is appended in a `[refs: …]` list so
 * a load-bearing reference is never silently lost.
 */
const truncatePreservingTokens = (raw: string, limit: number): string => {
  const s = collapse(raw)
  if (s.length <= limit) return s

  const spans = protectedSpans(s)
  let cut = limit
  for (const span of spans) {
    if (span.start < cut && span.end > cut) cut = span.end
  }

  const head = s.slice(0, cut).trimEnd()
  const lost: Array<string> = []
  for (const span of spans) {
    if (span.start >= cut && !lost.includes(span.text)) lost.push(span.text)
  }

  const refs = lost.slice(0, 8)
  const suffix = refs.length > 0 ? `… [refs: ${refs.join(" ")}]` : "…"
  return `${head}${suffix}`
}

interface ParsedTool {
  readonly name: string
  readonly input: string
  readonly output: string
}

// Tool rows carry the projected multi-line body `[Tool: Name]\nState: …\nInput:\n
// {…}\nOutput:\n…` (see artifact-projection `toolLines`). Pull out name + the
// Input/Output blocks; anything unparseable falls back to name "tool".
const parseToolBody = (body: string): ParsedTool => {
  const lines = body.split("\n")
  const nameMatch = lines[0]?.match(/^\[Tool:\s*(.*)\]$/)
  const name = nameMatch?.[1]?.trim() || "tool"
  const inputAt = lines.findIndex((l) => l === "Input:")
  const outputAt = lines.findIndex((l) => l === "Output:")
  const slice = (from: number, to: number) =>
    from === -1 ? "" : lines.slice(from + 1, to === -1 ? undefined : to).join("\n").trim()
  const input = inputAt === -1 ? "" : slice(inputAt, outputAt)
  const output = outputAt === -1 ? "" : slice(outputAt, -1)
  return { name, input, output }
}

const isNoiseUser = (body: string): boolean => {
  const trimmed = body.trimStart()
  return trimmed.startsWith("<local-command") || trimmed.startsWith("Caveat:")
}

const renderRow = (row: TimelineRow, caps: TimelineCaps): string | null => {
  if (SKIP_ROLES.has(row.role)) return null
  const body = row.body.trim()
  if (body.length === 0) return null

  switch (row.role) {
    case "user": {
      if (isNoiseUser(body)) return null
      return `USER: ${truncatePreservingTokens(body, caps.user)}`
    }
    case "assistant":
      return `ASSISTANT: ${truncatePreservingTokens(body, caps.assistant)}`
    case "subagent":
      return `SUBAGENT: ${truncatePreservingTokens(body, caps.assistant)}`
    case "tool": {
      const tool = parseToolBody(body)
      const input = tool.input ? `(${truncatePreservingTokens(tool.input, caps.toolInput)})` : ""
      const output = tool.output ? ` => ${truncatePreservingTokens(tool.output, caps.toolOutput)}` : ""
      return `TOOL ${tool.name}${input}${output}`
    }
    default:
      return null
  }
}

const renderWithCaps = (rows: ReadonlyArray<TimelineRow>, caps: TimelineCaps): string => {
  const lines: Array<string> = []
  for (const row of rows) {
    const rendered = renderRow(row, caps)
    if (rendered !== null) lines.push(rendered)
  }
  return lines.join("\n")
}

const scaleCaps = (caps: TimelineCaps, factor: number): TimelineCaps => ({
  user: Math.max(CAP_FLOOR.user, Math.round(caps.user * factor)),
  assistant: Math.max(CAP_FLOOR.assistant, Math.round(caps.assistant * factor)),
  toolInput: Math.max(CAP_FLOOR.toolInput, Math.round(caps.toolInput * factor)),
  toolOutput: Math.max(CAP_FLOOR.toolOutput, Math.round(caps.toolOutput * factor)),
})

const atFloor = (caps: TimelineCaps): boolean =>
  caps.user <= CAP_FLOOR.user &&
  caps.assistant <= CAP_FLOOR.assistant &&
  caps.toolInput <= CAP_FLOOR.toolInput &&
  caps.toolOutput <= CAP_FLOOR.toolOutput

export const renderTimeline = (
  rows: ReadonlyArray<TimelineRow>,
  options: RenderTimelineOptions = {},
): string => {
  let caps = options.caps ?? DEFAULT_TIMELINE_CAPS
  let out = renderWithCaps(rows, caps)

  const budget = options.charBudget
  if (budget === undefined || out.length <= budget) return out

  // Shrink caps proportionally toward the floor. A few passes converge because
  // the fixed scaffolding (role prefixes, tool names) doesn't scale, so the last
  // pass may still overflow — that's the accepted graceful-degradation tail.
  for (let pass = 0; pass < 4; pass++) {
    if (out.length <= budget || atFloor(caps)) break
    caps = scaleCaps(caps, budget / out.length)
    out = renderWithCaps(rows, caps)
  }
  return out
}
