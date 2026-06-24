import type { JSX, ReactNode } from "react"
import { tildify } from "../../format-path.js"
import { Label } from "../../ui/Label.js"
import { CodeBlock, obj, str } from "./tool-body.js"
import { chromeVerb } from "./chrome-tool-name.js"

// Dedicated rendering for the **Claude-in-Chrome MCP toolkit**
// (`mcp__claude-in-chrome__<verb>`). Like the arc toolkit, these are an MCP
// namespace we know the exact arg shapes of, so instead of the generic raw-JSON
// fallback we surface the *action*: the URL navigated to, the click target, the
// typed text, the script run. MCP tools are deliberately absent from the shared
// catalog (an open namespace, not an enumerated family — see tool-catalog.ts),
// so this lives outside `toolBody`'s catalog dispatch and is selected by name in
// `ToolCall.tsx`.
//
// Arg-key spellings below are verified against real ingested calls (`computer`
// `{action,coordinate,tabId}`, `javascript_tool` `{action:"javascript_exec",text}`,
// `browser_batch` `{actions:[{name,input}]}`, `find` `{query}`), not guessed.
//
// Tool-name parsing (the per-CLI name flattening) lives in `./chrome-tool-name.ts`,
// pure string logic kept separate so it's unit-testable under the Node runner.
export { isChromeTool, chromeToolLabel } from "./chrome-tool-name.js"

const MONO = "font-mono text-[11px] text-foreground [overflow-wrap:anywhere]"
const CHIP =
  "flex-none rounded-[var(--radius)] border border-border px-1.5 py-px font-mono text-[10px] uppercase tracking-[0.04em] text-fg-dim"

const Row = ({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element => (
  <div className="flex items-baseline gap-1.5 min-w-0">
    <Label kind="meta">{label}</Label>
    <span className={MONO}>{children}</span>
  </div>
)

/** A bordered enum chip — the computer action, a "new tab" marker, a batch verb. */
const Chip = ({ children }: { readonly children: ReactNode }): JSX.Element => <span className={CHIP}>{children}</span>

/** A `[x, y]` coordinate pair (computer clicks/moves) as a readable `x, y`. */
const coordOf = (a: Record<string, unknown>): string | null => {
  const c = a["coordinate"]
  if (Array.isArray(c) && c.length >= 2 && typeof c[0] === "number" && typeof c[1] === "number") {
    return `${c[0]}, ${c[1]}`
  }
  return null
}

/** The tab a call targets, shown as a thin trailing field when present — most
 * read/navigate verbs carry a `tabId` and it's worth seeing which. */
const tabRow = (a: Record<string, unknown>): JSX.Element | null => {
  const tabId = str(a["tabId"]) ?? str(a["tab_id"]) ?? (typeof a["tabId"] === "number" ? String(a["tabId"]) : null)
  return tabId ? <Row label="tab">{tabId}</Row> : null
}

/** A `url` field (navigate) — the most salient thing a browser call does. */
const urlRow = (a: Record<string, unknown>): JSX.Element | null => {
  const url = str(a["url"])
  return url ? <Row label="url">{url}</Row> : null
}

/**
 * The `computer` tool — the workhorse: a click, a keypress, typed text, a
 * screenshot, a scroll, a wait. Render the action as a chip with its target
 * (coordinate) and payload (typed text / key combo / wait duration) so the
 * interaction reads at a glance.
 */
const ComputerArgs = ({ a }: { readonly a: Record<string, unknown> }): JSX.Element => {
  const action = str(a["action"])
  const coord = coordOf(a)
  const text = str(a["text"])
  const duration = typeof a["duration"] === "number" ? a["duration"] : null
  return (
    <div className="flex flex-wrap items-center gap-2 min-w-0">
      {action && <Chip>{action.replace(/_/g, " ")}</Chip>}
      {coord && <Row label="at">{coord}</Row>}
      {duration != null && <Row label="for">{`${duration}s`}</Row>}
      {text != null && <span className={`min-w-0 flex-1 truncate ${MONO}`}>{text}</span>}
    </div>
  )
}

/** One sub-action of a `browser_batch` — `{ name, input }`, where `name` is the
 * bare verb and `input` its args — rendered as a labelled row reusing the same
 * per-verb dispatch as a standalone call. */
const BatchRow = ({ name, input }: { readonly name: string; readonly input: unknown }): JSX.Element => (
  <div className="flex items-baseline gap-2 min-w-0 border-l border-border pl-2">
    <Chip>{name}</Chip>
    <div className="min-w-0 flex-1">{verbBody(name, obj(input)) ?? <span className={MONO}>…</span>}</div>
  </div>
)

/**
 * Per-**verb** rendering of a Claude-in-Chrome tool's input — the dispatch core,
 * keyed on the bare verb so both a standalone call and a `browser_batch`
 * sub-action flow through it. Returns null when there's nothing worth showing
 * beyond the verb itself (`read_page`, `tabs_context`, …) or the verb is
 * unmodelled, so the caller can fall back to formatted JSON.
 */
function verbBody(verb: string, a: Record<string, unknown> | null): JSX.Element | null {
  if (!a) return null
  switch (verb) {
    case "computer":
      return <ComputerArgs a={a} />
    case "navigate":
      return (
        <div className="grid gap-1.5 min-w-0">
          {urlRow(a)}
          {tabRow(a)}
        </div>
      )
    case "tabs_create_mcp":
      return <Chip>new tab</Chip>
    case "tabs_close_mcp":
      return tabRow(a)
    case "javascript_tool": {
      // Code lives in `text` (the call carries `action: "javascript_exec"`); keep
      // `code`/`script` as fallbacks in case the shape ever changes.
      const code = str(a["text"]) ?? str(a["code"]) ?? str(a["script"])
      return code ? <CodeBlock text={code} /> : null
    }
    case "find": {
      const target = str(a["query"]) ?? str(a["description"]) ?? str(a["selector"])
      return target ? <Row label="find">{target}</Row> : null
    }
    case "form_input": {
      const field = str(a["selector"]) ?? str(a["field"]) ?? str(a["name"])
      const value = str(a["value"]) ?? str(a["text"])
      if (!field && value == null) return null
      return (
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {field && <Row label="field">{field}</Row>}
          {value != null && <span className={`min-w-0 flex-1 truncate ${MONO}`}>{value}</span>}
        </div>
      )
    }
    case "read_console_messages":
      return str(a["pattern"]) ? <Row label="pattern">{str(a["pattern"])}</Row> : tabRow(a)
    case "read_page":
      return str(a["filter"]) ? <Row label="filter">{str(a["filter"])}</Row> : tabRow(a)
    case "resize_window": {
      const w = a["width"]
      const h = a["height"]
      return typeof w === "number" && typeof h === "number" ? <Row label="size">{`${w}×${h}`}</Row> : null
    }
    case "file_upload":
    case "upload_image": {
      const path = str(a["path"]) ?? str(a["file_path"]) ?? str(a["filePath"])
      return path ? <Row label="file">{tildify(path)}</Row> : null
    }
    case "gif_creator": {
      const name = str(a["filename"]) ?? str(a["path"]) ?? str(a["name"])
      return (
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          {str(a["action"]) && <Chip>{str(a["action"])}</Chip>}
          {name && <span className={MONO}>{name}</span>}
        </div>
      )
    }
    case "shortcuts_execute": {
      const shortcut = str(a["name"]) ?? str(a["shortcut"])
      return shortcut ? <Row label="shortcut">{shortcut}</Row> : null
    }
    case "select_browser":
    case "switch_browser": {
      const browser = str(a["browserId"]) ?? str(a["name"])
      return browser ? <Row label="browser">{browser}</Row> : null
    }
    case "browser_batch": {
      const actions = Array.isArray(a["actions"]) ? a["actions"] : []
      if (actions.length === 0) return null
      return (
        <div className="grid gap-1.5 min-w-0">
          {actions.map(obj).map((act, i) => (
            // The sub-action list is immutable (a projected call's args never
            // change or reorder) and repeats identical actions (three identical
            // clicks), so the positional index is the only stable, unique key.
            // eslint-disable-next-line react/no-array-index-key
            <BatchRow key={i} name={str(act?.["name"]) ?? "?"} input={act?.["input"]} />
          ))}
        </div>
      )
    }
    default:
      // read_network_requests, tabs_context_mcp, get_page_text,
      // list_connected_browsers, shortcuts_list — thin args; show the tab if one
      // was targeted, else nothing (the verb in the header is the whole story).
      return urlRow(a) ?? tabRow(a)
  }
}

/**
 * Per-verb rendering of a Claude-in-Chrome tool's **input**, dispatched from the
 * namespaced tool name. Thin wrapper over {@link verbBody} (which `browser_batch`
 * also reuses for its sub-actions).
 */
export function chromeToolBody(toolName: string, args: unknown): JSX.Element | null {
  return verbBody(chromeVerb(toolName), obj(args))
}
