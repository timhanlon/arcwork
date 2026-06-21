import type { ReactNode } from "react"
import type { ToolCall as ToolCallData } from "../../../../shared/tool-call.js"
import { WORK_STATUSES } from "../../work/work-status-display.js"
import { ToolCall } from "./ToolCall.js"

// The arc MCP toolkit (`arc.<verb>`) rendered through ToolCall — the cards that
// replace the generic raw-JSON MCP fallback. Samples are trimmed real shapes
// (args + result JSON) drawn from ingested transcripts, so the grid exercises the
// exact payloads the renderer must handle — including the per-CLI name flattening
// (Claude `mcp__arc__arc_*`, Cursor `mcp_arc_arc_*`, Codex `arc_*`). Sibling story
// `Chat / ToolCall` covers the first-party (catalog) tools.
export default {
  title: "Chat / ArcToolCall",
}

const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div
    style={{
      width: 460,
      maxWidth: "100%",
      padding: "10px 12px",
      border: "1px solid var(--border)",
      borderLeft: "2px solid var(--border)",
      background: "var(--elev)",
    }}
  >
    {children}
  </div>
)

const Case = ({ label, tool }: { readonly label: string; readonly tool: ToolCallData }) => (
  <div>
    <div
      style={{
        marginBottom: 6,
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 11,
        color: "var(--fg-dim)",
      }}
    >
      {label}
    </div>
    <Frame>
      {/* provider is irrelevant for arc tools — the name prefix drives the render. */}
      <ToolCall tool={tool} provider="claude" />
    </Frame>
  </div>
)

const tool = (
  toolName: string,
  args: unknown,
  output?: string,
  state: ToolCallData["state"] = "output-available",
): ToolCallData => ({ kind: "tool", state, toolName, args, ...(output ? { output } : {}) })

// ── sample payloads ───────────────────────────────────────────────────────────

const createdWork = {
  _tag: "Work",
  id: "work_01ktym68j0f20vjh5jj780n9w1",
  nodeId: "work_rev_01ktym68j0f20vjh5xmqe6kw5d",
  title: "Chat pane snaps code block fully into view when scrolling up",
  status: "open",
  priority: "p2",
  labels: ["bug", "arcwork", "renderer"],
}

const workCreateArgs = {
  title: "Chat pane snaps code block fully into view when scrolling up (use-stick-to-bottom resize/escape race)",
  status: "open",
  priority: "p2",
  labels: ["bug", "arcwork", "renderer"],
  body: [
    "## Symptom",
    "",
    "In the chat pane, when a code block is not fully visible and you scroll up *at all*, the view snaps back so the whole code block is in view.",
    "",
    "## Root cause",
    "",
    "The transcript is pinned by `use-stick-to-bottom` (`UnifiedChatPane.tsx:112`, configured `resize: \"smooth\"`). The snap is that hook re-pinning to bottom.",
    "",
    "## Fixes (ranked)",
    "1. Wrap `Message` in `React.memo` — stops every scroll tick re-rendering all code blocks.",
    "2. Change `resize: \"smooth\"` → `resize: \"instant\"` — drops the 350ms tail holding the race open.",
  ].join("\n"),
  citations: [
    { kind: "file", target: "src/renderer/src/UnifiedChatPane.tsx", note: "useStickToBottom config (line 112-115)" },
    { kind: "file", target: "src/renderer/src/components/Message.tsx", note: "not memoized; wrap in React.memo" },
  ],
}

const workComment = {
  _tag: "WorkComment",
  id: "comment_01ktyg4cdpexrszzjznne7hnaz",
  workRefId: "work_01ktxk6mp1fvmrtndffwwc9d33",
  body: "Investigation update — the fix does not need to patch Effect at all. arc owns the HTTP layer, so add a global `HttpRouter.middleware` that rewrites empty-body 200 → 202. Survives `pnpm install`, spec-correct, version-proof.",
}

// A bundled `arc.work.update`: a content revision + status move + priority bump +
// comment in one call. Result is the final work plus the comment it created.
const workUpdateArgs = {
  workRefId: "work_01ktxk6mp1fvmrtndffwwc9d33",
  set: {
    status: "active",
    priority: "p1",
    body: "Decision: rewrite empty-body 200 → 202 in a global `HttpRouter.middleware` at arc's HTTP layer — no node_modules patch.",
  },
  addComment: { body: workComment.body },
}

const fullWork = {
  _tag: "Work",
  id: "work_01ktxk6mp1fvmrtndffwwc9d33",
  nodeId: "work_rev_01ktxk6mp1fvmrtndnne15gs95",
  title: "Persist Effect MCP notification HTTP fix",
  body: "Codex MCP startup for the arc server failed while sending notifications/initialized: the Effect HTTP RPC transport returned HTTP 200 with an empty body for JSON-RPC notifications.\n\n## Remaining durable work\n- Upstream the fix or carry it as a dependency patch.\n- Remove reliance on direct node_modules edits.",
  labels: ["bug", "mcp", "effect"],
  status: "open",
  priority: null,
  citations: [
    { kind: "file", target: "tests/arcwork-mcp-server.test.ts", note: "Arc regression coverage" },
  ],
}

const searchResult = {
  hits: [
    { ref: "work_01ktym68j0f20vjh5jj780n9w1", kind: "work", title: "Chat pane snaps code block into view on scroll", preview: "The transcript is pinned by use-stick-to-bottom; the snap is that hook re-pinning to bottom.", updatedAt: "2026-06-12T19:15:54.048Z", score: 4.2 },
    { ref: "work_01ktxk6mp1fvmrtndffwwc9d33", kind: "work", title: "Persist Effect MCP notification HTTP fix", preview: "Effect HTTP RPC transport returned 200 + empty body for JSON-RPC notifications.", updatedAt: "2026-06-12T09:39:23.456Z", score: 3.1 },
    { ref: "chat_01ktxdtcv3fewvsj1rsvpk5a9a", kind: "chat", title: "arc MCP server hardening", preview: "Codex client torn down during startup; EOF while parsing.", updatedAt: "2026-06-12T08:00:00.000Z", score: 2.0 },
  ],
  total: 7,
  nextCursor: "b3Vmc2V0OjM=",
}

// ── cases ─────────────────────────────────────────────────────────────────────

/** A write that authors a full unit of work — rendered as a work card, with a
 * compact result line echoing the created id + status. */
export const WorkCreate = () => (
  <Case
    label="arc.work.create"
    tool={tool("mcp__arc__arc_work_create", workCreateArgs, JSON.stringify(createdWork))}
  />
)

/** The consolidated edit door — one call bundles a content revision, a status
 * move, a priority bump, and a comment; result echoes the final work card. */
export const WorkUpdate = () => (
  <Case
    label="arc.work.update"
    tool={tool(
      "mcp__arc__arc_work_update",
      workUpdateArgs,
      JSON.stringify({ work: { ...fullWork, status: "active", priority: "p1" }, comment: workComment }),
    )}
  />
)

/** The same `arc.work.update` call as Codex flattens it (`arc_<verb>`, no `mcp__`
 * namespace) — proves the renderer matches arc calls across CLI name formats. */
export const WorkUpdateCodexName = () => (
  <Case
    label="arc_work_update (Codex name flattening)"
    tool={tool(
      "arc_work_update",
      workUpdateArgs,
      JSON.stringify({ work: { ...fullWork, status: "active", priority: "p1" }, comment: workComment }),
    )}
  />
)

/** The triad hydrator — `arc.get` of a single ref: thin ref arg, hydrated work
 * card as the result. */
export const Get = () => (
  <Case
    label="arc.get (single work)"
    tool={tool(
      "arc_get",
      { ref: fullWork.id },
      JSON.stringify({
        entities: [{ _tag: "work", work: fullWork, comments: [{}, {}], olderRevisionCommentCount: 0 }],
        notFound: [],
      }),
    )}
  />
)

/** A batched `arc.get` mixing kinds — work / chat / message entities listed on
 * bordered rows, with a `notFound` line for the ref that resolved to nothing. */
export const GetBatch = () => (
  <Case
    label="arc.get (batch + notFound)"
    tool={tool(
      "arc_get",
      { refs: [fullWork.id, "chat_01ktxdtcv3fewvsj1rsvpk5a9a", "message_01ktxk6mp1fvmrtndffwwc9d34", "work_deadbeef"] },
      JSON.stringify({
        entities: [
          { _tag: "work", work: fullWork, comments: [{}], olderRevisionCommentCount: 0 },
          { _tag: "chat", chat: { _tag: "Chat", id: "chat_01ktxdtcv3fewvsj1rsvpk5a9a", title: "arc MCP server hardening" } },
          {
            _tag: "message",
            message: {
              _tag: "ChatMessage",
              id: "message_01ktxk6mp1fvmrtndffwwc9d34",
              role: "tool",
              body: "Process exited with code 0\nAll 379 tests passed.",
              payload: { kind: "tool", toolName: "shell" },
            },
          },
        ],
        notFound: ["work_deadbeef"],
      }),
    )}
  />
)

/** Discovery — query + kind/status chips; result is a list of thin hit rows. */
export const Search = () => (
  <Case
    label="arc.search"
    tool={tool("mcp__arc__arc_search", { query: "mcp notification", kinds: ["work", "chat"], filters: { status: ["open"] } }, JSON.stringify(searchResult))}
  />
)

/** Every status move as a *pending* `work.update` — the `→ status` badge the
 * card shows before the result lands (`WorkUpdateArgs` → `StatusBadge`). Resolved
 * targets (done/superseded) carry the check-square; the rest are the bare status
 * word. The matrix to iterate the status-change rendering against. */
export const StatusChangePending = () => (
  <div style={{ display: "grid", gap: 22 }}>
    {WORK_STATUSES.map((status) => (
      <Case
        key={status}
        label={`arc.work.update → ${status} (pending)`}
        tool={tool(
          "mcp__arc__arc_work_update",
          { workRefId: fullWork.id, set: { status } },
          undefined,
          "input-available",
        )}
      />
    ))}
  </div>
)

/** Every status as a *result* Work card — exercises `WorkLine`'s shared
 * `WorkStatusMarker` (an icon for blocked/done/superseded, none for open/active),
 * the dimmed title for resolved work, and the trailing status word. The result
 * supersedes the input line, so this is the card a settled `work.update` leaves
 * in the transcript. */
export const StatusChangeResult = () => (
  <div style={{ display: "grid", gap: 22 }}>
    {WORK_STATUSES.map((status) => (
      <Case
        key={status}
        label={`result Work · ${status}`}
        tool={tool(
          "mcp__arc__arc_work_update",
          { workRefId: fullWork.id, set: { status } },
          JSON.stringify({ work: { ...fullWork, status }, comment: workComment }),
        )}
      />
    ))}
  </div>
)

/** A pending call (no result yet). */
export const Pending = () => (
  <Case
    label="arc.work.create (pending)"
    tool={tool("mcp__arc__arc_work_create", { title: "Investigate flaky test", status: "open", labels: ["test"], body: "Pin down the intermittent failure in the ingest port suite." }, undefined, "input-available")}
  />
)

/** Every case stacked, the way a transcript shows them. */
export const All = () => (
  <div style={{ display: "grid", gap: 22 }}>
    <WorkCreate />
    <WorkUpdate />
    <WorkUpdateCodexName />
    <Get />
    <GetBatch />
    <Search />
    <Pending />
  </div>
)
