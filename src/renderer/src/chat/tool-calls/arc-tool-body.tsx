import type { JSX, ReactNode } from "react"
import type { WorkStatus } from "../../../../shared/work.js"
import { isWorkPriority, isWorkStatus } from "../../../../shared/work.js"
import { PriorityChip } from "../../work/work-priority-controls.js"
import { isResolved } from "../../work/work-status-display.js"
import { WorkStatusMarker } from "../../work/WorkStatusMarker.js"
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
 * payload (a pending `→ active`, the settled state on a work line). Pairs with the
 * shared `WorkStatusMarker` icon, which carries the resolved/blocked glance and
 * the title dimming; this is the precise word, the one signal the marker omits for
 * the open/active states. */
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


// ── work line ─────────────────────────────────────────────────────────────────

/**
 * A unit of work as a single compact line — `[✓] title  status  [priority]`. The
 * transcript card is a *reference* to the work, not a reproduction: the body,
 * labels and citations all live in the work pane, one click away via the id. The
 * shared shape for an authored `work_create` and a hydrated `work_get` / result
 * Work. Built from the same status primitives as every other surface — the shared
 * `WorkStatusMarker` leads with the resolved/blocked glance and drives the dimmed
 * title (`isResolved`), the title fills the row, then the precise status word and
 * priority trail to the right.
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
  const resolved = isWorkStatus(status) && isResolved(status)
  const titleCls = `min-w-0 flex-1 truncate text-left text-[12px] ${resolved ? "text-fg-faint" : "text-foreground"}`
  return (
    <div className="flex items-center gap-2 min-w-0">
      {isWorkStatus(status) && <WorkStatusMarker status={status} title={status} placeholder={false} />}
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
      {isWorkStatus(status) && <StatusBadge status={status} />}
      {isWorkPriority(priority) && <PriorityChip priority={priority} />}
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

// ── get: hydrated entities ──────────────────────────────────────────────────

/** A stable list key for a hydrated entity — the contained record's id, falling
 * back to the array index when (defensively) absent. */
const entityRef = (e: Record<string, unknown>): string | null =>
  str(obj(e["work"])?.["id"]) ?? str(obj(e["chat"])?.["id"]) ?? str(obj(e["message"])?.["id"])

/** One hydrated entity from `arc.get`, dispatched on `_tag`. Every kind leads
 * with the same kind chip (the shared left column across a mixed batch — work's
 * status/priority are trailing detail on the reused `WorkLine`, not the leading
 * token); `chat`/`message` render their title/preview. The transcript stays a
 * *reference* — the full body (and comment thread) is one click away in the pane,
 * so even a message body is a two-line preview. */
const EntityLine = ({
  entity,
  onOpenWork,
}: {
  readonly entity: Record<string, unknown>
  readonly onOpenWork?: (workId: string) => void
}): JSX.Element | null => {
  switch (str(entity["_tag"])) {
    case "work": {
      const work = obj(entity["work"])
      if (!work) return null
      return (
        <div className="flex items-center gap-2 min-w-0">
          <Chip>work</Chip>
          <div className="min-w-0 flex-1">
            <WorkLine work={work} onOpenWork={onOpenWork} />
          </div>
        </div>
      )
    }
    case "chat": {
      const chat = obj(entity["chat"])
      if (!chat) return null
      return (
        <div className="flex items-center gap-2 min-w-0">
          <Chip>chat</Chip>
          <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">
            {str(chat["title"]) ?? "untitled"}
          </span>
        </div>
      )
    }
    case "message": {
      const message = obj(entity["message"])
      if (!message) return null
      // A tool row leads with the tool name; a conversational row with its role.
      const label = str(obj(message["payload"])?.["toolName"]) ?? str(message["role"]) ?? "message"
      return (
        <div className="grid gap-1 min-w-0">
          <div className="flex items-center gap-2 min-w-0">
            <Chip>{label}</Chip>
          </div>
          <Body text={str(message["body"]) ?? ""} />
        </div>
      )
    }
    default:
      return null
  }
}

/** The `arc.get` result — a batch of hydrated entities plus any refs that
 * resolved to nothing. A single entity renders bare (it reads like a `work_get`);
 * a batch lists them on bordered rows, collapsing past a screenful. `notFound` is
 * never an error — a partial batch still shows what resolved. */
const GetEntities = ({
  entities,
  notFound,
  onOpenWork,
}: {
  readonly entities: ReadonlyArray<unknown>
  readonly notFound: ReadonlyArray<string>
  readonly onOpenWork?: (workId: string) => void
}): JSX.Element => {
  const cards = entities.map(obj)
  return (
    <div className="grid gap-1.5 min-w-0">
      {cards.length === 1 && cards[0] ? (
        <EntityLine entity={cards[0]} onOpenWork={onOpenWork} />
      ) : (
        cards.length > 1 && (
          <Collapsible collapsedHeight={200}>
            <ul className="m-0 flex list-none flex-col gap-1.5 p-0">
              {cards.map((entity, i) =>
                entity ? (
                  <li key={entityRef(entity) ?? i} className="border-l border-border pl-2 min-w-0">
                    <EntityLine entity={entity} onOpenWork={onOpenWork} />
                  </li>
                ) : null,
              )}
            </ul>
          </Collapsible>
        )
      )}
      {notFound.length > 0 && <span className={FIELD_LABEL}>not found: {notFound.join(", ")}</span>}
    </div>
  )
}

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
      {isWorkStatus(status) && (
        <>
          <span className="text-fg-faint">→</span>
          <StatusBadge status={status} />
        </>
      )}
      {isWorkPriority(priority) && <PriorityChip priority={priority} />}
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
          {isWorkStatus(a["status"]) && (
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
 * True when the result card already conveys what the input would — a Work echo
 * (create / update / get / status), or an `arc.get` batch of hydrated entities
 * (whose refs the input merely names). `ToolCall` then renders the result alone,
 * dropping the now-redundant input line. Stays false for a degenerate empty get
 * (no entities, nothing not-found) so we don't hide a card that won't render.
 */
export function arcResultSupersedesInput(output: string): boolean {
  if (resultWork(output) !== null) return true
  const parsed = obj(tryParse(output))
  if (!parsed || !Array.isArray(parsed["entities"])) return false
  const notFound = Array.isArray(parsed["notFound"]) ? parsed["notFound"] : []
  return parsed["entities"].length > 0 || notFound.length > 0
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
  // get: { entities, notFound }
  if (Array.isArray(parsed["entities"])) {
    const entities = parsed["entities"]
    const notFound = Array.isArray(parsed["notFound"])
      ? parsed["notFound"].map(str).filter((r): r is string => Boolean(r))
      : []
    if (entities.length === 0 && notFound.length === 0) return null
    return <GetEntities entities={entities} notFound={notFound} onOpenWork={onOpenWork} />
  }
  return null
}
