import type { ReactNode } from "react"
import { useState } from "react"
import type { Work, WorkComment, WorkCommentListing } from "../../../shared/work.js"
import { WorkComments, WorkCreateForm, WorkDetailView, WorkListView } from "./WorkPane.js"

export default {
  title: "Work / WorkPane",
}

/** A center-column-sized frame so the pane lays out like it does in the app. */
const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div
    style={{
      width: 560,
      maxWidth: "100%",
      height: 520,
      display: "flex",
      flexDirection: "column",
      border: "1px solid var(--border)",
      background: "var(--bg)",
    }}
  >
    {children}
  </div>
)

const work = (over: Partial<Work> & Pick<Work, "id" | "title" | "status">): Work => ({
  _tag: "Work",
  nodeId: `work_rev_${over.id}`,
  body: "",
  labels: [],
  createdAt: "2026-06-05T10:00:00.000Z",
  updatedAt: "2026-06-07T09:30:00.000Z",
  provenance: { source: "cli" },
  citations: [],
  ...over,
  priority: over.priority ?? null,
})

const fixtures: ReadonlyArray<Work> = [
  work({
    id: "work_01a",
    title: "Forward-only document graph primitive",
    status: "active",
    labels: ["proposal", "graph"],
    priority: "p1",
  }),
  work({ id: "work_01b", title: "Investigate hook attribution", status: "open", labels: ["bug"], priority: "p0" }),
  work({ id: "work_01c", title: "Decide whether agents write markdown", status: "blocked", labels: ["decision"], priority: "p2" }),
  work({ id: "work_01d", title: "Ship the RPC seam", status: "done", labels: ["plan"] }),
  work({ id: "work_01e", title: "Old caching idea", status: "superseded" }),
]

const counts = {
  all: fixtures.length,
  open: 1,
  active: 1,
  blocked: 1,
  done: 1,
  superseded: 1,
}

const detailed: Work = work({
  id: "work_01a",
  title: "Forward-only document graph primitive",
  status: "active",
  labels: ["proposal", "graph"],
  priority: "p1",
  body: "A single `work` primitive collapses plan/todo/task/proposal/bug/decision.\n\nStatus is an append-only event on the ref, not a content revision.",
  provenance: {
    source: "mcp",
    chatId: "chat_01xyz",
    execution: { harness: "codex", model: "gpt-5.4" },
  },
  citations: [
    { kind: "file", target: "docs/proposals/2026-06-06-document-graph-primitive-api.md", note: "reasoning trail" },
    { kind: "work", target: "work_01b" },
  ],
})

const noop = (): void => {}

// ── Comment fixtures ─────────────────────────────────────────────────────────

const CURRENT_NODE = "work_rev_current"

const comment = (
  over: Partial<WorkComment> & Pick<WorkComment, "id" | "body">,
): WorkComment => ({
  _tag: "WorkComment",
  workRefId: "work_01a",
  subjectKind: "node",
  subjectId: CURRENT_NODE,
  createdAt: "2026-06-08T14:20:00.000Z",
  provenance: { source: "cli", actor: "codex", sessionId: "target_01abc234def" },
  ...over,
})

const currentComments: WorkCommentListing = {
  currentNodeId: CURRENT_NODE,
  olderRevisionCommentCount: 2,
  comments: [
    comment({
      id: "comment_01a",
      body: "Codex flags the **CAS** path: status edges should not allocate a new node.",
      provenance: { source: "cli", actor: "codex", sessionId: "target_01abc234def" },
    }),
    comment({
      id: "comment_01b",
      subjectKind: "ref",
      subjectId: "work_01a",
      body: "Decision: keep comments append-only; no resolving in v0.",
      provenance: { source: "rpc", chatId: "chat_01xyz789" },
    }),
  ],
}

const allRevisionComments: WorkCommentListing = {
  currentNodeId: CURRENT_NODE,
  olderRevisionCommentCount: 2,
  comments: [
    ...currentComments.comments,
    comment({
      id: "comment_01c",
      subjectId: "work_rev_older1",
      body: "On the first draft: the title undersold the scope.",
      createdAt: "2026-06-06T09:00:00.000Z",
    }),
    comment({
      id: "comment_01d",
      subjectId: "work_rev_older2",
      body: "Earlier note — superseded by the current body.",
      createdAt: "2026-06-07T11:30:00.000Z",
    }),
  ],
}

/** The list with the status filter — the default navigator surface. */
export const List = () => (
  <Frame>
    <WorkListView
      work={fixtures}
      counts={counts}
      tab="all"
      onTab={noop}
      onSelect={noop}
      onNew={noop}
    />
  </Frame>
)

/** Empty list state for a filter with no matches. */
export const EmptyList = () => (
  <Frame>
    <WorkListView
      work={[]}
      counts={{ all: 0, open: 0, active: 0, blocked: 0, done: 0, superseded: 0 }}
      tab="blocked"
      onTab={noop}
      onSelect={noop}
      onNew={noop}
    />
  </Frame>
)

/** Detail view with body, labels, citations, status control, and provenance. */
export const Detail = () => (
  <Frame>
    <WorkDetailView work={detailed} onBack={noop} onStatus={noop} onPriority={noop} onRevise={noop} />
  </Frame>
)

/** Detail view with comments on the current revision, plus an indicator that
 * older revisions carry comments the default view omits. */
export const DetailWithComments = () => {
  const [showAll, setShowAll] = useState(false)
  return (
    <Frame>
      <WorkDetailView
        work={detailed}
        comments={showAll ? allRevisionComments : currentComments}
        showAllComments={showAll}
        onToggleAllComments={setShowAll}
        onBack={noop}
        onStatus={noop}
        onPriority={noop}
        onRevise={noop}
      />
    </Frame>
  )
}

/** The comments section on its own — current-revision view, with the toggle to
 * reveal older-revision comments wired to local state. */
export const Comments = () => {
  const [showAll, setShowAll] = useState(false)
  return (
    <Frame>
      <div style={{ padding: 16 }}>
        <WorkComments
          listing={showAll ? allRevisionComments : currentComments}
          showAll={showAll}
          onToggleAll={setShowAll}
        />
      </div>
    </Frame>
  )
}

/** The comments section showing every comment across revisions, each clearly
 * labelled by subject (current revision, older revision, work item). */
export const CommentsAllRevisions = () => (
  <Frame>
    <div style={{ padding: 16 }}>
      <WorkComments listing={allRevisionComments} showAll onToggleAll={noop} />
    </div>
  </Frame>
)

/** The authoring form — create work without an agent. */
export const Create = () => (
  <Frame>
    <WorkCreateForm onCancel={noop} onCreate={noop} />
  </Frame>
)
