import type { JSX, ReactNode } from "react"
import type { WorkPriority, WorkStatus } from "../../../../shared/work.js"
import { PriorityChip } from "../../work/work-priority-controls.js"
import { Button } from "../../ui/Button.js"
import { Label } from "../../ui/Label.js"
import { Collapsible, obj, str } from "./tool-body.js"
import { arcVerb } from "./arc-tool-name.js"

// Dedicated rendering for the **arc MCP toolkit** (`arc.<verb>`). These are arc's
// own domain verbs reflected back through MCP, so unlike a generic MCP tool we
// know their exact arg/result shapes (Work, WorkComment, search hits) and can
// render them as the same cards the work surfaces use instead of raw JSON. MCP
// tools are deliberately absent from the shared catalog (an open namespace, not
// an enumerated family — see tool-catalog.ts), so this lives outside `toolBody`'s
// catalog dispatch and is selected by name in `ToolCall.tsx`.
//
// Tool-name parsing (the per-CLI name flattening) lives in `./arc-tool-name.ts`,
// pure string logic kept separate so it's unit-testable under the Node runner;
// `isArcTool` / `arcToolLabel` are re-exported below for existing import sites.
export { isArcTool, arcToolLabel } from "./arc-tool-name.js"

const FIELD_LABEL = "font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint"
const MONO = "font-mono text-[11px] text-foreground [overflow-wrap:anywhere]"
const CHIP =
  "flex-none rounded-[var(--radius)] border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.04em] text-fg-dim"

// ── shared primitives ─────────────────────────────────────────────────────────

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element => (
  <div className="flex items-baseline gap-1.5 min-w-0">
    <Label kind="meta">{label}</Label>
    <span className={MONO}>{children}</span>
  </div>
)

/** A bordered enum chip — work-comment kind, handoff state, review decision, … */
const Chip = ({ children }: { readonly children: ReactNode }): JSX.Element => (
  <span className={CHIP}>{children}</span>
)

/** Status as a bare word — the reported state on an arc card, where status is the
 * payload. No icon: the word already says "done", so a check beside it is pure
 * redundancy. (The sidebar lists, which show no word, keep the check-square as
 * their only completion signal — see `WorkStatusMarker`.) */
const StatusBadge = ({ status }: { readonly status: WorkStatus }): JSX.Element => (
  <span className="flex-none font-mono text-[11px] text-fg-dim">{status}</span>
)

/** The affordance back to the full work item in the right pane — a plain "open"
 * button, no raw id, no unicode arrow. The transcript card is a *reference* to
 * the work; this is the handle. Renders nothing when there's no id to open
 * (authored `work_create` input pre-result) or no `onOpenWork` wired (Storybook). */
const OpenButton = ({
  id,
  onOpenWork,
}: {
  readonly id?: string | null
  readonly onOpenWork?: (workId: string) => void
}): JSX.Element | null =>
  id && onOpenWork ? (
    <Button variant="ghost" size="sm" className="flex-none" onClick={() => onOpenWork(id)}>
      open
    </Button>
  ) : null

/** A markdown field (body / summary / instructions) reduced to a two-line
 * plain-text preview. The transcript references work, it doesn't reproduce it —
 * the full body is one click away in the pane (via the id), so a long writeup no
 * longer dominates the transcript. */
const Body = ({ text }: { readonly text: string }): JSX.Element | null => {
  const preview = text
    .replace(/```[\s\S]*?```/g, " ") // drop fenced code blocks
    .replace(/^#{1,6}\s+/gm, "") // strip heading markers, keep the words
    .replace(/\s+/g, " ")
    .trim()
  return preview.length === 0 ? null : <p className="m-0 line-clamp-2 text-[11px] text-fg-faint">{preview}</p>
}

const isStatus = (value: unknown): value is WorkStatus =>
  value === "open" || value === "active" || value === "blocked" || value === "done" || value === "superseded"

const isPriority = (value: unknown): value is WorkPriority =>
  value === "p0" || value === "p1" || value === "p2" || value === "p3"

// ── work line ─────────────────────────────────────────────────────────────────

/**
 * A unit of work as a single compact line — `active  title  [priority]`. The
 * transcript card is a *reference* to the work, not a reproduction: the body,
 * labels and citations all live in the work pane, one click away via the id. The
 * shared shape for an authored `work_create` and a hydrated `work_get` / result
 * Work — the status word leads, the title truncates to one row.
 */
const WorkLine = ({
  work,
  onOpenWork,
}: {
  readonly work: Record<string, unknown>
  readonly onOpenWork?: (workId: string) => void
}): JSX.Element => {
  const title = str(work["title"]) ?? "untitled"
  const status = work["status"]
  const priority = work["priority"]
  const id = str(work["id"])
  const titleCls = "min-w-0 flex-1 truncate text-left text-[12px] text-foreground"
  return (
    <div className="flex items-center gap-2 min-w-0">
      {isStatus(status) && <StatusBadge status={status} />}
      {id && onOpenWork ? (
        <Button
          variant="link"
          title={title}
          onClick={() => onOpenWork(id)}
          className={titleCls}
        >
          {title}
        </Button>
      ) : (
        <span className={titleCls} title={title}>
          {title}
        </span>
      )}
      {isPriority(priority) && <PriorityChip priority={priority} />}
    </div>
  )
}

// ── search hits ───────────────────────────────────────────────────────────────

const SearchHits = ({ hits, total }: { readonly hits: ReadonlyArray<unknown>; readonly total: number }): JSX.Element => (
  <div className="grid gap-1.5 min-w-0">
    <span className={FIELD_LABEL}>
      {hits.length} of {total} {total === 1 ? "hit" : "hits"}
    </span>
    <Collapsible collapsedHeight={200}>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
        {hits.map(obj).map((hit, i) => {
          if (!hit) return null
          const ref = str(hit["ref"])
          return (
            <li key={ref ?? i} className="grid gap-0.5 min-w-0 border-l border-border pl-2">
              <div className="flex items-baseline gap-2 min-w-0">
                <Chip>{str(hit["kind"]) ?? "?"}</Chip>
                <span className="min-w-0 flex-1 truncate text-[11px] text-foreground">{str(hit["title"])}</span>
              </div>
              {str(hit["preview"]) && (
                <span className="line-clamp-2 text-[11px] text-fg-faint">{str(hit["preview"])}</span>
              )}
              {ref && <span className="font-mono text-[10px] text-fg-faint">{ref}</span>}
            </li>
          )
        })}
      </ul>
    </Collapsible>
  </div>
)

// ── input dispatch ────────────────────────────────────────────────────────────

const refField = (a: Record<string, unknown>, onOpenWork?: (workId: string) => void): JSX.Element | null => {
  const ref = str(a["workRefId"]) ?? str(a["ref"])
  const refs = Array.isArray(a["refs"]) ? (a["refs"] as ReadonlyArray<unknown>).map(str).filter(Boolean) : []
  if (ref) return <OpenButton id={ref} onOpenWork={onOpenWork} />
  if (refs.length > 0) return <Row label="refs">{refs.join(", ")}</Row>
  return null
}

const SearchArgs = ({ a }: { readonly a: Record<string, unknown> }): JSX.Element => {
  const kinds = Array.isArray(a["kinds"]) ? (a["kinds"] as ReadonlyArray<string>) : []
  const filters = obj(a["filters"]) ?? {}
  const status = Array.isArray(filters["status"]) ? (filters["status"] as ReadonlyArray<string>) : []
  const labels = Array.isArray(filters["labels"]) ? (filters["labels"] as ReadonlyArray<string>) : []
  const chatId = str(filters["chatId"])
  return (
    <div className="grid gap-1.5 min-w-0">
      {str(a["query"]) && <Row label="query">{str(a["query"])}</Row>}
      {(kinds.length > 0 || status.length > 0 || labels.length > 0) && (
        <div className="flex flex-wrap gap-1">
          {kinds.map((k) => (
            <Chip key={`k:${k}`}>{k}</Chip>
          ))}
          {status.map((s) => (
            <Chip key={`s:${s}`}>{s}</Chip>
          ))}
          {labels.map((l) => (
            <Chip key={`l:${l}`}>{l}</Chip>
          ))}
        </div>
      )}
      {chatId && <Row label="chat">{chatId}</Row>}
    </div>
  )
}

/** The `work_update` **input**, shown only while the call is pending (no result
 * yet) — once the result Work lands it supersedes this as the canonical line.
 * Stays to a single row: the pending status move (`→ active`) and the priority.
 * The current status isn't in the args, so there's no honest `from`; the bare
 * `→ status` reads as "moving to". The full body/comment live in the work pane. */
const WorkUpdateArgs = ({ a }: { readonly a: Record<string, unknown> }): JSX.Element => {
  const set = obj(a["set"]) ?? {}
  const status = set["status"]
  const priority = set["priority"]
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      {isStatus(status) && (
        <>
          <span className="text-fg-faint">→</span>
          <StatusBadge status={status} />
        </>
      )}
      {isPriority(priority) && <PriorityChip priority={priority} />}
    </div>
  )
}

/**
 * Per-verb rendering of an arc tool's **input**. Write verbs that carry authored
 * content (work_create / work_update / handoff / review) render it as a card;
 * lookup verbs render their ref/query. Returns null when there's nothing worth
 * showing (empty-arg reads like work_list), so the caller can omit the body.
 */
export function arcToolBody(
  toolName: string,
  args: unknown,
  onOpenWork?: (workId: string) => void,
): JSX.Element | null {
  const a = obj(args)
  if (!a) return null
  switch (arcVerb(toolName)) {
    case "work_create":
      return <WorkLine work={a} onOpenWork={onOpenWork} />
    case "work_update":
      return <WorkUpdateArgs a={a} />
    // `work_comment` / `work_status` are no longer offered by the MCP server
    // (folded into `work_update`), but historical transcripts still carry these
    // calls, so keep rendering them.
    case "work_comment":
      return (
        <div className="grid gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Chip>{str(a["kind"]) ?? "comment"}</Chip>
            <OpenButton id={str(a["workRefId"])} onOpenWork={onOpenWork} />
          </div>
          <Body text={str(a["body"]) ?? ""} />
        </div>
      )
    case "work_status":
      return (
        <div className="flex items-center gap-2 min-w-0">
          {refField(a, onOpenWork)}
          {isStatus(a["status"]) && (
            <>
              <span className="text-fg-faint">→</span>
              <StatusBadge status={a["status"]} />
            </>
          )}
        </div>
      )
    case "review_completion":
      return (
        <div className="grid gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {str(a["decision"]) && <Chip>{str(a["decision"])}</Chip>}
            {refField(a, onOpenWork)}
          </div>
          <Body text={str(a["summary"]) ?? ""} />
          {str(a["instructions"]) && (
            <>
              <span className={FIELD_LABEL}>instructions</span>
              <Body text={str(a["instructions"]) ?? ""} />
            </>
          )}
        </div>
      )
    case "handoff_create":
      return (
        <div className="grid gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {str(a["provider"]) && <Chip>{str(a["provider"])}</Chip>}
            {refField(a, onOpenWork)}
          </div>
          <Body text={str(a["instructions"]) ?? ""} />
        </div>
      )
    case "handoff_report":
      return (
        <div className="grid gap-2 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            {str(a["state"]) && <Chip>{str(a["state"])}</Chip>}
            {refField(a, onOpenWork)}
          </div>
          <Body text={str(a["summary"]) ?? ""} />
        </div>
      )
    case "search":
      return <SearchArgs a={a} />
    case "get":
    case "work_get":
    case "work_for_target":
    case "prime":
      return (
        refField(a, onOpenWork) ?? (str(a["targetSessionId"]) ? <Row label="target">{str(a["targetSessionId"])}</Row> : null)
      )
    default:
      // work_list, workspace_context, monitoring_summary — thin/empty args.
      return null
  }
}

// ── output dispatch ───────────────────────────────────────────────────────────

const tryParse = (text: string): unknown => {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

/**
 * Per-verb rendering of an arc tool's **result** when it's a shape we model: a
 * Work / WorkComment card, a hydrated `work_get` work, or search hits. Returns
 * null for everything else (errors, large read dumps, file-spfilled results) so
 * the caller falls back to the raw output block.
 */
/** The Work in a result, whether returned bare (`{_tag:"Work"}` from create /
 * update / status) or wrapped (`{work}` from work_get). Drives both the result
 * rendering and the input-supersede check below. */
const resultWork = (output: string): Record<string, unknown> | null => {
  const parsed = obj(tryParse(output))
  if (!parsed) return null
  if (parsed["_tag"] === "Work") return parsed
  const work = obj(parsed["work"])
  return work?.["_tag"] === "Work" ? work : null
}

/**
 * True when the result is a Work echo (create / update / get / status). The
 * authored input for those verbs would just duplicate it, so `ToolCall` renders
 * the result line alone — see the supersede check there.
 */
export function arcOutputIsWork(output: string): boolean {
  return resultWork(output) !== null
}

export function arcToolOutput(output: string, onOpenWork?: (workId: string) => void): JSX.Element | null {
  const work = resultWork(output)
  if (work) return <WorkLine work={work} onOpenWork={onOpenWork} />
  const parsed = obj(tryParse(output))
  if (!parsed) return null
  // search: { hits, total, nextCursor }
  if (Array.isArray(parsed["hits"])) {
    return <SearchHits hits={parsed["hits"]} total={typeof parsed["total"] === "number" ? parsed["total"] : parsed["hits"].length} />
  }
  return null
}
