import { Schema } from "effect"
import { ChatId, CommentId, WorkId, WorkRevId, WorkspaceId } from "./ids.js"

/**
 * **work** — arc's durable unit of intent: something to investigate, decide, fix,
 * plan, implement, review, or hand off. This deliberately collapses
 * `plan`/`todo`/`task`/`proposal`/`bug`/`decision` into one primitive; those
 * words are labels and maturity states, not separate types.
 *
 * This module is the *contract*, not a transport. The same `Work` /
 * `WorkCreateInput` schemas back every door onto the work API — the renderer RPC
 * seam and the in-process MCP work tools (`arc.work.*`) — so a transport is only
 * ever decode → run `WorkService` → encode. See
 * `docs/proposals/2026-06-06-document-graph-primitive-api.md`.
 *
 * `Work` itself is a *projection* over the graph substrate (immutable revision
 * nodes + a mutable ref); it is never the stored row. `id` is the durable ref
 * identity; `nodeId` is the current revision it points at.
 */

/**
 * Authored lifecycle status the agent sets. Distinct (by design) from the
 * *derived* execution state arc infers from observed events (the sidebar
 * work-queue's `running`/`needs_attention`/…). v0 only persists authored status;
 * reconciling the two vocabularies is deliberately deferred.
 */
export const WORK_STATUSES = ["open", "active", "blocked", "done", "superseded"] as const
export const WorkStatus = Schema.Literals(WORK_STATUSES)
export type WorkStatus = typeof WorkStatus.Type

/** Narrow an unknown (e.g. a JSON-parsed tool payload) to a {@link WorkStatus}.
 * The one canonical guard — surfaces that render status must not re-derive it. */
export const isWorkStatus = (value: unknown): value is WorkStatus =>
  typeof value === "string" && (WORK_STATUSES as ReadonlyArray<string>).includes(value)

/**
 * The non-terminal statuses (everything not done/superseded): the open buckets a
 * queue projection surfaces, and — as {@link OpenWorkStatus} — the only transitions
 * the untrusted MCP surface may set. Closing work (`done`/`superseded`) is a
 * terminal transition reserved for the trusted RPC/UI path and the review gate; the
 * generic `arc.work.update` MCP verb (its `set.status`) cannot express it by construction.
 */
export const OPEN_WORK_STATUSES = ["open", "active", "blocked"] as const
export const OpenWorkStatus = Schema.Literals(OPEN_WORK_STATUSES)
export type OpenWorkStatus = typeof OpenWorkStatus.Type

/**
 * Authored priority — a small, sortable ranking the agent sets so the queue
 * knows what to pick next. It's the one signal labels can't express (labels
 * don't sort), and it's orthogonal to status (lifecycle, not importance).
 *
 * There is deliberately **no default**: unset is a real state, distinct from
 * `p3` ("ranked low"), so the queue can tell "nobody ranked this" from "ranked
 * lowest". Like status, priority is a *workflow fact* — an append-only
 * `priority_set` edge on the ref, latest wins — never content, so
 * re-prioritizing mints no revision. `p0` is highest; the queue orders
 * `p0 < p1 < p2 < p3 < unset`.
 */
export const WORK_PRIORITIES = ["p0", "p1", "p2", "p3"] as const
export const WorkPriority = Schema.Literals(WORK_PRIORITIES)
export type WorkPriority = typeof WorkPriority.Type

/** Narrow an unknown to a {@link WorkPriority}. Canonical guard — see {@link isWorkStatus}. */
export const isWorkPriority = (value: unknown): value is WorkPriority =>
  typeof value === "string" && (WORK_PRIORITIES as ReadonlyArray<string>).includes(value)

export const CITATION_KINDS = ["file", "commit", "pr", "session", "url", "work"] as const
export const CitationKind = Schema.Literals(CITATION_KINDS)
export type CitationKind = typeof CitationKind.Type

/**
 * A pointer from a piece of work to its evidence/source. A `work` citation
 * targets another work ref id; the others target an external locator (path, sha,
 * PR number, session id, url). Citations become `references` edges on create.
 */
export const Citation = Schema.Struct({
  kind: CitationKind,
  target: Schema.String,
  note: Schema.optional(Schema.String),
})
export type Citation = typeof Citation.Type

/**
 * The execution runtime a write was observed to come from — the harness driving
 * the session and the model it was last seen using. Kept as a nested struct
 * rather than more flat top-level provenance fields so the runtime story can grow
 * (preset, backend, deployment, …) without the top level sprouting a nullable
 * column per detail: top-level provenance stays authorship/routing (`source`,
 * `actor`, `sessionId`, `chatId`); execution metadata lives here.
 *
 * Both fields are *observed*, never authored: arc resolves them from the trusted
 * `sessionId` at write time — `harness` from the target session's provider,
 * `model` from the latest model seen on that session's transcript/hook stream.
 * `model` deliberately is NOT read from launch env: a session can switch models
 * mid-run, so it must reflect the current observed model, not the launch default.
 */
export const WorkExecution = Schema.Struct({
  /** Harness/provider identity driving the session — `claude` | `codex` | `cursor` | … */
  harness: Schema.optional(Schema.String),
  /** Latest model observed on the session at write time (mutable runtime state). */
  model: Schema.optional(Schema.String),
})
export type WorkExecution = typeof WorkExecution.Type

/**
 * Where a write came from. The agent should NOT supply what arc already knows:
 * arc derives session/chat/workspace from the active session + observation layer
 * (for the CLI, from the `ARC_*` env stamps it inherits). `source` names the
 * door: `cli`, `rpc`, … This is the proposal's load-bearing v0 dependency — if
 * session context never reaches the tool, `created_in_session` is null and the
 * provenance value collapses. `execution` carries the observed harness/model of
 * the authoring session (see {@link WorkExecution}); omitted when no session is
 * known or none has been observed yet.
 */
export const WorkProvenance = Schema.Struct({
  actor: Schema.optional(Schema.String),
  // Deliberately unbranded: an authoring session is either an interactive target
  // (`target_…`) or a batch run (`run_…`) — the two Instance subtypes — so no single
  // ArcId prefix fits. (Today's resolvers assume a target; a run author would reuse
  // this same field.) Same reasoning as `Citation.target`.
  sessionId: Schema.optional(Schema.String),
  chatId: Schema.optional(ChatId),
  workspaceId: Schema.optional(WorkspaceId),
  source: Schema.String,
  execution: Schema.optional(WorkExecution),
})
export type WorkProvenance = typeof WorkProvenance.Type

/** A unit of work, projected to what a queue/detail view needs. */
export const Work = Schema.Struct({
  _tag: Schema.Literal("Work"),
  id: WorkId, // ref identity
  nodeId: WorkRevId, // current revision node
  title: Schema.String,
  body: Schema.String,
  labels: Schema.Array(Schema.String),
  status: WorkStatus,
  // null when no priority has been set — distinct from any p-level (see WorkPriority).
  priority: Schema.NullOr(WorkPriority),
  createdAt: Schema.String,
  updatedAt: Schema.String,
  provenance: WorkProvenance,
  citations: Schema.Array(Citation),
})
export type Work = typeof Work.Type

/**
 * A work item reduced to its queue-header fields — what a thin index/orient view
 * (notably `arc.workspace_context`) needs to list and rank open work without
 * shipping every item's full markdown `body`. This is the progressive-disclosure
 * half of the contract: headers here, drill into the body (and comments) on
 * demand with `arc.work_get`. Deliberately omits `body`, `provenance`,
 * `citations`, `nodeId`, and `createdAt` — none belong in a header.
 */
export const WorkSummary = Schema.Struct({
  _tag: Schema.Literal("WorkSummary"),
  id: WorkId, // ref identity
  title: Schema.String,
  labels: Schema.Array(Schema.String),
  status: WorkStatus,
  // null when no priority has been set — distinct from any p-level (see WorkPriority).
  priority: Schema.NullOr(WorkPriority),
  updatedAt: Schema.String,
})
export type WorkSummary = typeof WorkSummary.Type

/**
 * The smallest authored shape. arc fills in identity, revision, provenance, and
 * edges.
 */
export const WorkCreateInput = Schema.Struct({
  title: Schema.String,
  body: Schema.String,
  labels: Schema.optional(Schema.Array(Schema.String)),
  status: Schema.optional(WorkStatus),
  // Optional at create — omitted leaves the work unranked (no priority_set edge).
  priority: Schema.optional(WorkPriority),
  citations: Schema.optional(Schema.Array(Citation)),
})
export type WorkCreateInput = typeof WorkCreateInput.Type

/**
 * An authored content edit. Each field is optional — an omitted field is left
 * unchanged; a present field replaces it (including `labels`, which replaces the
 * whole set). Status is deliberately absent: it is a workflow event
 * (`update_status`), not content. A revise mints a new immutable revision node
 * and moves the ref; the prior revision stays as history.
 */
export const WorkReviseInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  body: Schema.optional(Schema.String),
  labels: Schema.optional(Schema.Array(Schema.String)),
})
export type WorkReviseInput = typeof WorkReviseInput.Type

/**
 * A content search over the work graph. `query` is whitespace-split into terms;
 * a unit matches when every term appears (case-insensitively) in its title,
 * body, or labels. `labels`/`statuses` narrow the set (a unit must carry all
 * given labels and be in one of the given statuses); both default to "any", so
 * search spans every status — done/superseded work stays findable, unlike the
 * open-queue projections. `limit` caps results (newest activity first); omit it
 * for the full match set (the read surface needs that to count and paginate).
 */
export const WorkSearchQuery = Schema.Struct({
  query: Schema.String,
  labels: Schema.optional(Schema.Array(Schema.String)),
  statuses: Schema.optional(Schema.Array(WorkStatus)),
  limit: Schema.optional(Schema.Number),
})
export type WorkSearchQuery = typeof WorkSearchQuery.Type

/**
 * What a comment is *about*. A `node` comment is anchored to one immutable
 * revision — the default, so a remark lands on the exact text it discusses and
 * stays with that revision when the work is later revised. A `ref` comment is
 * about the durable work item as a whole, independent of any revision.
 */
export const WorkCommentSubjectKind = Schema.Literals(["node", "ref"])
export type WorkCommentSubjectKind = typeof WorkCommentSubjectKind.Type

/**
 * A comment attached to a piece of work — the durable place agents capture a
 * Codex/Claude back-and-forth without copying text around. It anchors to the
 * specific graph object discussed: by default the *current revision node* (so
 * the remark stays with the text it was about), or the *ref* for a note about
 * the work as a whole. `workRefId` is denormalized so comments list by work id
 * with one indexed query; `subjectId` is the node or ref it actually hangs off.
 */
export const WorkComment = Schema.Struct({
  _tag: Schema.Literal("WorkComment"),
  id: CommentId,
  workRefId: WorkId, // the durable work ref this comment belongs to
  subjectKind: WorkCommentSubjectKind,
  // a work_rev_… node (subjectKind 'node') or a work_… ref ('ref'), per subjectKind
  subjectId: Schema.Union([WorkRevId, WorkId]),
  body: Schema.String,
  createdAt: Schema.String,
  provenance: WorkProvenance,
})
export type WorkComment = typeof WorkComment.Type

/**
 * The smallest authored shape for a comment. arc fills in identity, the subject
 * (current node by default, the ref when `ref` is set), provenance, and time.
 */
export const WorkCommentInput = Schema.Struct({
  body: Schema.String,
  /** Attach to the durable work ref instead of the current revision node. */
  ref: Schema.optional(Schema.Boolean),
})
export type WorkCommentInput = typeof WorkCommentInput.Type

/**
 * A work's comments as a view needs them. `comments` is the list filtered by the
 * request — current-revision node comments plus ref comments by default, or every
 * comment (including prior revisions) when all-revisions is asked for.
 * `currentNodeId` lets a caller mark which comments sit on the current revision;
 * `olderRevisionCommentCount` is the number of node comments on *previous*
 * revisions, the indicator the default view shows even when those comments are
 * omitted from the list.
 */
export const WorkCommentListing = Schema.Struct({
  currentNodeId: WorkRevId,
  comments: Schema.Array(WorkComment),
  olderRevisionCommentCount: Schema.Number,
})
export type WorkCommentListing = typeof WorkCommentListing.Type

/**
 * The change descriptor `WorkService.changes` publishes on every real mutation,
 * carried to renderers as the element of the `WatchWorkChanges` RPC stream. It is
 * an *invalidation*, not a list: work has several heterogeneous reads (per-chat,
 * workspace-wide, per-work comments), so consumers re-pull their own query on a
 * tick rather than receiving one canonical list. Defined as a schema here so the
 * RPC contract keys off this one definition rather than a parallel wire copy.
 */
export const WorkChange = Schema.Struct({
  /** The mutated work ref. */
  refId: WorkId,
  /** The work's authoring chat, when known — lets a consumer scope its refetch. */
  chatId: Schema.NullOr(ChatId),
})
export type WorkChange = typeof WorkChange.Type
