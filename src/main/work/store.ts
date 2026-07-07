import { Context, Data, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  WORK_SCHEMA_VERSION,
  workMigrations,
  type SummaryNodeRow,
  type WorkCommentRow,
  type WorkEdgeRow,
  type WorkNodeRow,
  type WorkProjectionRow,
  type WorkRefRow,
  type WorkRefUpdateRow,
} from "./schema.js"
import { newArcId, type ChatId, type SummaryId, type TargetId, type WorkspaceId } from "../../shared/ids.js"
import { runMigrations } from "../db/migrator.js"
import { latestStatus } from "./work-sql.js"

/** The idempotency key for a distilled summary — a re-distill with an identical
 * key returns the existing node instead of writing a duplicate. */
export interface SummaryKey {
  readonly chatId: string
  readonly model: string
  readonly promptVersion: number
  readonly inputHash: string
}

// The `summary_json` metadata blob written alongside a summary node (see
// SummaryNodeRow). Decoded best-effort on read; a corrupt blob reads as "no
// summary" rather than throwing (mirrors parseLabels).
const SummaryMeta = Schema.Struct({
  model: Schema.String,
  promptVersion: Schema.Number,
  promptTokens: Schema.NullOr(Schema.Number),
  completionTokens: Schema.NullOr(Schema.Number),
  durationMs: Schema.NullOr(Schema.Number),
})
const decodeSummaryMeta = Schema.decodeUnknownOption(Schema.fromJsonString(SummaryMeta))

interface SummaryRawRow {
  readonly id: SummaryId
  readonly chatId: ChatId
  readonly workspaceId: WorkspaceId | null
  readonly body: string
  readonly inputHash: string
  readonly summaryJson: string | null
  readonly createdAt: string
}

const toSummaryRow = (raw: SummaryRawRow): SummaryNodeRow | null => {
  const meta = raw.summaryJson ? decodeSummaryMeta(raw.summaryJson) : undefined
  if (!meta || meta._tag === "None") return null
  return {
    id: raw.id,
    chatId: raw.chatId,
    workspaceId: raw.workspaceId,
    body: raw.body,
    inputHash: raw.inputHash,
    model: meta.value.model,
    promptVersion: meta.value.promptVersion,
    promptTokens: meta.value.promptTokens,
    completionTokens: meta.value.completionTokens,
    durationMs: meta.value.durationMs,
    createdAt: raw.createdAt,
  }
}

/**
 * SQL layer over the work graph substrate — the low-level door (mirrors
 * `ArcStore`'s role for arc's domain). The product verbs (`create`, the
 * projections) live in `WorkService`; this only knows nodes/refs/edges.
 *
 * Reuses the same `@effect/sql-sqlite-node` client as `ArcStore`. In the app
 * both stores share one SqliteClient over `.arc/state/arc.sqlite` (Effect
 * memoizes the layer).
 *
 * The model keeps two things apart: an immutable **node** is the authored
 * *content* of a unit of work (title/body/labels), and **status** is a
 * *workflow fact* — an append-only `status_set` edge on the ref. A status flip
 * never mints a content revision (that would blur "what was said" with "what
 * happened later"); current status is projected as the latest `status_set`
 * event, falling back to the node's authored status. Content revisions (a future
 * `work.revise`) will move `graph_ref`'s pointer via a CAS-shaped update.
 */

/** Decode a projection row's `labelsJson` to a string array, best-effort: a
 * corrupt blob or non-array yields `[]`, and any non-string element is dropped.
 * Shared by the store's own filters and `WorkService`'s projections. */
export const parseLabels = (labelsJson: string): ReadonlyArray<string> => {
  try {
    const parsed = JSON.parse(labelsJson)
    return Array.isArray(parsed) ? parsed.filter((label): label is string => typeof label === "string") : []
  } catch {
    return []
  }
}

/** A work projection joined to its current `delegated_to` edge — the reverse
 * "what work is on this implementer?" link, hydrated for the monitoring read
 * model. */
export interface DelegatedWorkRow extends WorkProjectionRow {
  /** The target-session id of the latest `delegated_to` edge. */
  readonly targetSessionId: TargetId
  /** When that delegation edge was written. */
  readonly delegatedAt: string
}

/** Everything one `work.create` writes, pre-built by the service in one shot. */
export interface WorkCreateSpec {
  readonly node: WorkNodeRow
  readonly ref: WorkRefRow
  readonly refUpdate: WorkRefUpdateRow
  readonly edges: ReadonlyArray<WorkEdgeRow>
}

/** Everything one content revision (`work.revise`) writes: the new frozen
 * content node, the CAS expectation, the ref-update log row, and the `revises`
 * edge to the prior node. Status is unaffected — it lives in events on the ref. */
export interface WorkRevisionSpec {
  readonly refId: string
  /** The node the ref is expected to currently point at — the CAS guard. */
  readonly expectedOldNodeId: string
  readonly node: WorkNodeRow
  readonly refUpdate: WorkRefUpdateRow
  readonly revisesEdge: WorkEdgeRow
  readonly updatedAt: string
}

/** The ref moved under us: it no longer points at `expectedNodeId`, so another
 * writer revised this work first. The caller decides how to surface the clash. */
export class WorkRefConflict extends Data.TaggedError("arc/WorkRefConflict")<{
  readonly refId: string
  readonly expectedNodeId: string
}> {}

export class WorkStore extends Context.Service<
  WorkStore,
  {
    /** Insert node + ref + ref-update + edges atomically. */
    readonly createWork: (spec: WorkCreateSpec) => Effect.Effect<void, SqlError>
    /** Mint a new content revision and compare-and-swap the ref from its
     * expected current node to the new one. Fails {@link WorkRefConflict} (and
     * writes nothing) if the ref drifted; otherwise writes node + ref-move +
     * ref-update log + `revises` edge atomically. */
    readonly applyRevision: (spec: WorkRevisionSpec) => Effect.Effect<void, SqlError | WorkRefConflict>
    /** Append a single edge off a ref and bump its `updated_at` (recency).
     * Writes no node — used for append-only workflow facts (`status_set`) and
     * live relationships (`blocks`, `depends_on`, …). */
    readonly recordEdge: (
      refId: string,
      edge: WorkEdgeRow,
      updatedAt: string,
    ) => Effect.Effect<void, SqlError>
    /** Open buckets (open/active/blocked), newest ref activity first. */
    readonly loadOpenWork: Effect.Effect<ReadonlyArray<WorkProjectionRow>, SqlError>
    /** Every unit of work regardless of status, newest ref activity first — the
     * global navigator's source, which filters by status client-side. */
    readonly loadAllWork: Effect.Effect<ReadonlyArray<WorkProjectionRow>, SqlError>
    /** A single work's current projection, or null if the ref is unknown. */
    readonly loadWork: (refId: string) => Effect.Effect<WorkProjectionRow | null, SqlError>
    /** Content search: each whitespace term must match (case-insensitively) the
     * title, body, or labels; `labels` further require those exact labels and
     * `statuses` restrict to those derived statuses (empty = any). Newest ref
     * activity first, capped at `limit`. */
    readonly searchWork: (opts: {
      readonly terms: ReadonlyArray<string>
      readonly labels: ReadonlyArray<string>
      readonly statuses: ReadonlyArray<string>
      /** Cap on results; omit for the full match set. */
      readonly limit?: number
    }) => Effect.Effect<ReadonlyArray<WorkProjectionRow>, SqlError>
    /** All work whose authoring provenance is a given chat (any status), newest
     * ref activity first — the chat-scoped projection the UI shows in context. */
    readonly loadWorkForChat: (
      chatId: string,
    ) => Effect.Effect<ReadonlyArray<WorkProjectionRow>, SqlError>
    /** Every unit of work that carries a `delegated_to` edge, paired with its
     * *latest* such edge (the current implementer) — the reverse lookup the
     * monitoring projection drives off, so it never scans prose comments. Newest
     * delegation first; a work re-delegated more than once appears once. */
    readonly loadDelegatedWork: Effect.Effect<ReadonlyArray<DelegatedWorkRow>, SqlError>
    /** The work whose *current* implementer is a given target session — the
     * target-scoped reverse of {@link loadDelegatedWork} ("what is on this
     * implementer right now?"). Only work whose latest `delegated_to` edge points
     * at `targetSessionId` matches, so work since re-delegated elsewhere drops
     * out. Same projection/ordering as the unfiltered lookup. */
    readonly loadDelegatedWorkForTarget: (
      targetSessionId: string,
    ) => Effect.Effect<ReadonlyArray<DelegatedWorkRow>, SqlError>
    /** `references`/`derived_from` edges off a work ref, as citation tuples.
     * `toKind` discriminates a graph ref (`ref`) from an encoded external
     * `kind:target` locator (`external`); for a ref endpoint `refKind` is the
     * cited ref's own `kind` (so the citation kind is read, never assumed). */
    readonly loadCitations: (
      refId: string,
    ) => Effect.Effect<
      ReadonlyArray<{
        readonly toKind: string
        readonly target: string
        readonly note: string | null
        readonly refKind: string | null
      }>,
      SqlError
    >
    /** Outgoing edges of a given type from a ref (e.g. references/created_in_session). */
    readonly loadEdges: (
      fromId: string,
      type: string,
    ) => Effect.Effect<ReadonlyArray<WorkEdgeRow>, SqlError>
    /** Append one comment row (append-only; comments are never revised) and bump
     * the work ref's `updated_at` to the comment time — a comment is recent
     * activity, so it refreshes recency like an edge does. */
    readonly insertComment: (row: WorkCommentRow) => Effect.Effect<void, SqlError>
    /** Every comment on a work ref — node comments on any revision plus ref
     * comments — oldest first. The service filters current vs. all-revisions; the
     * `work_ref_id` index makes this one scan. */
    readonly loadComments: (
      workRefId: string,
    ) => Effect.Effect<ReadonlyArray<WorkCommentRow>, SqlError>
    /** Insert a distilled chat-summary node plus its `summarizes` edge to the
     * chat, atomically. Idempotent on the identity tuple (the
     * `graph_node_summary_idem` unique index): returns `true` when this call
     * persisted the row, `false` when an identical-key summary already won the
     * race — the caller re-reads the winner rather than duplicating it. */
    readonly insertSummary: (row: SummaryNodeRow) => Effect.Effect<boolean, SqlError>
    /** The summary matching an idempotency key, or null — the guard that makes a
     * re-distill with identical inputs return the existing summary. */
    readonly loadSummaryByKey: (key: SummaryKey) => Effect.Effect<SummaryNodeRow | null, SqlError>
    /** A chat's most recent summary node, or null when none exists. */
    readonly loadLatestSummaryForChat: (
      chatId: string,
    ) => Effect.Effect<SummaryNodeRow | null, SqlError>
  }
>()("arcwork/WorkStore") {}

export const WorkStoreLive = Layer.effect(
  WorkStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient

    // Mirror ArcStore's connection setup: WAL for a concurrent reader + writer, a
    // busy timeout so an overlapping write waits out the lock instead of failing
    // with SQLITE_BUSY, then referential actions.
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA busy_timeout = 5000`
    yield* sql`PRAGMA foreign_keys = ON`
    yield* runMigrations("work_migrations", workMigrations)

    const insertNode = (n: WorkNodeRow) =>
      sql`INSERT INTO graph_node ${sql.insert({
        id: n.id,
        kind: n.kind,
        contentHash: n.contentHash,
        title: n.title,
        body: n.body,
        labelsJson: n.labelsJson,
        status: n.status,
        actor: n.actor,
        sessionId: n.sessionId,
        chatId: n.chatId,
        workspaceId: n.workspaceId,
        deviceId: n.deviceId,
        observedSource: n.observedSource,
        executionJson: n.executionJson,
        createdAt: n.createdAt,
        schemaVersion: n.schemaVersion,
      })}`.pipe(Effect.asVoid)

    const insertRef = (r: WorkRefRow) =>
      sql`INSERT INTO graph_ref ${sql.insert({
        id: r.id,
        kind: r.kind,
        currentNodeId: r.currentNodeId,
        displayName: r.displayName,
        location: r.location,
        actor: r.actor,
        workspaceId: r.workspaceId,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
        schemaVersion: r.schemaVersion,
      })}`.pipe(Effect.asVoid)

    const insertRefUpdate = (u: WorkRefUpdateRow) =>
      sql`INSERT INTO graph_ref_update ${sql.insert({
        id: u.id,
        refId: u.refId,
        oldNodeId: u.oldNodeId,
        newNodeId: u.newNodeId,
        actor: u.actor,
        sessionId: u.sessionId,
        workspaceId: u.workspaceId,
        deviceId: u.deviceId,
        observedSource: u.observedSource,
        createdAt: u.createdAt,
        schemaVersion: u.schemaVersion,
      })}`.pipe(Effect.asVoid)

    const insertEdge = (e: WorkEdgeRow) =>
      sql`INSERT INTO graph_edge ${sql.insert({
        id: e.id,
        type: e.type,
        fromKind: e.fromKind,
        fromId: e.fromId,
        toKind: e.toKind,
        toId: e.toId,
        family: e.family,
        source: e.source,
        confidence: e.confidence,
        note: e.note,
        actor: e.actor,
        sessionId: e.sessionId,
        workspaceId: e.workspaceId,
        observedSource: e.observedSource,
        createdAt: e.createdAt,
        schemaVersion: e.schemaVersion,
      })}`.pipe(Effect.asVoid)

    const createWork = (spec: WorkCreateSpec) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* insertNode(spec.node)
          yield* insertRef(spec.ref)
          yield* insertRefUpdate(spec.refUpdate)
          yield* Effect.forEach(spec.edges, insertEdge, { discard: true })
        }),
      )

    const applyRevision = (spec: WorkRevisionSpec) =>
      sql.withTransaction(
        Effect.gen(function* () {
          // Insert the new content node first — the ref's FK needs it to exist
          // before the pointer can move. Then CAS: the UPDATE only matches while
          // the ref still points at the expected node, so a concurrent revision
          // makes `changes()` 0 and we fail, rolling the whole transaction back
          // (including the just-inserted node — no orphan revision is left).
          yield* insertNode(spec.node)
          yield* sql`UPDATE graph_ref
            SET current_node_id = ${spec.node.id}, updated_at = ${spec.updatedAt}
            WHERE id = ${spec.refId} AND current_node_id = ${spec.expectedOldNodeId}`
          const changed = yield* sql<{ changes: number }>`SELECT changes() AS changes`
          if ((changed[0]?.changes ?? 0) !== 1) {
            return yield* new WorkRefConflict({
              refId: spec.refId,
              expectedNodeId: spec.expectedOldNodeId,
            })
          }
          yield* insertRefUpdate(spec.refUpdate)
          yield* insertEdge(spec.revisesEdge)
        }),
      )

    const recordEdge = (refId: string, edge: WorkEdgeRow, updatedAt: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* insertEdge(edge)
          // The ref is the living identity; a new edge is recent activity.
          yield* sql`UPDATE graph_ref SET updated_at = ${updatedAt} WHERE id = ${refId}`
        }),
      )

    // Current status is the latest `status_set` event for the ref, falling back
    // to the node's authored status (stated intent at creation) when none exist
    // — the `latestStatus` builder shared with the search triggers. The content
    // node is never rewritten for a status flip. A parameter-free `sql` fragment
    // interpolated into every read below; the priority subquery is read-only.
    const projection = sql`
        r.id AS "id",
        r.current_node_id AS "nodeId",
        n.title AS "title",
        n.body AS "body",
        n.labels_json AS "labelsJson",
        ${sql.literal(latestStatus("r.id"))} AS "status",
        (
          SELECT pe.to_id FROM graph_edge pe
          WHERE pe.from_id = r.id AND pe.type = 'priority_set'
          ORDER BY pe.created_at DESC, pe.id DESC LIMIT 1
        ) AS "priority",
        r.created_at AS "createdAt",
        r.updated_at AS "updatedAt",
        n.actor AS "actor",
        n.session_id AS "sessionId",
        n.chat_id AS "chatId",
        n.workspace_id AS "workspaceId",
        n.observed_source AS "observedSource",
        n.execution_json AS "executionJson"
      FROM graph_ref r
      JOIN graph_node n ON n.id = r.current_node_id`

    // Queue ordering: priority first — p0 < p1 < p2 < p3 lexicographically — with
    // unset last (a priority that doesn't reorder the queue is decorative), then
    // recency. References the projected `"priority"` alias, visible to ORDER BY in
    // every query below (output aliases resolve there in SQLite).
    const PRIORITY_ORDER = `CASE WHEN "priority" IS NULL THEN 1 ELSE 0 END, "priority"`

    // Filter on the *derived* status, so it must wrap the projection (a computed
    // alias is not visible to WHERE on the same SELECT in SQLite).
    const loadOpenWork = sql<WorkProjectionRow>`
      SELECT * FROM (
        SELECT ${projection}
        WHERE r.kind = 'work'
      ) AS w
      WHERE w."status" IN ('open', 'active', 'blocked')
      ORDER BY ${sql.literal(PRIORITY_ORDER)}, w."updatedAt" DESC, w."id"`

    // Every unit of work regardless of status — the global navigator filters by
    // status client-side, so it needs done/superseded too (which `loadOpenWork`
    // drops). No derived-status WHERE here, so no projection wrapper is needed.
    const loadAllWork = sql<WorkProjectionRow>`
      SELECT ${projection}
      WHERE r.kind = 'work'
      ORDER BY ${sql.literal(PRIORITY_ORDER)}, r.updated_at DESC, r.id`

    const loadWork = (refId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<WorkProjectionRow>`
          SELECT ${projection}
          WHERE r.kind = 'work' AND r.id = ${refId}
          LIMIT 1`
        return rows[0] ?? null
      })

    // Content filters read the base columns (title/body/labels), so they live in
    // the inner SELECT; the status filter reads the *derived* status alias, so it
    // must wrap the projection in an outer WHERE — same reason `loadOpenWork`
    // does. All user input is parameterized; the `projection` fragment carries no
    // params of its own.
    const searchWork = (opts: {
      readonly terms: ReadonlyArray<string>
      readonly labels: ReadonlyArray<string>
      readonly statuses: ReadonlyArray<string>
      /** Cap on results; omit for the full match set (the read surface needs an
       * uncapped set to compute an honest `total` and paginate in memory). */
      readonly limit?: number
    }) => {
      // Escape LIKE wildcards in user input so a literal % or _ matches itself.
      const likeEscape = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`)
      const inner = []
      for (const term of opts.terms) {
        const pat = `%${likeEscape(term)}%`
        inner.push(
          sql`(n.title LIKE ${pat} ESCAPE '\\' OR n.body LIKE ${pat} ESCAPE '\\' OR n.labels_json LIKE ${pat} ESCAPE '\\')`,
        )
      }
      // A label is a JSON array member, so match the quoted token — "cli" must
      // not match a longer "client" label.
      for (const label of opts.labels) {
        inner.push(sql`n.labels_json LIKE ${`%"${likeEscape(label)}"%`} ESCAPE '\\'`)
      }
      const innerWhere = inner.length > 0 ? sql` AND ${sql.and(inner)}` : sql``
      // `sql.in(col, …)` would quote `w."status"` as one identifier, so spell
      // the IN out and use the bare value-list form.
      const outerWhere =
        opts.statuses.length > 0 ? sql` WHERE w."status" IN ${sql.in(opts.statuses)}` : sql``
      const limitClause = opts.limit !== undefined ? sql` LIMIT ${opts.limit}` : sql``
      return sql<WorkProjectionRow>`
        SELECT * FROM (
          SELECT ${projection}
          WHERE r.kind = 'work'${innerWhere}
        ) AS w${outerWhere}
        ORDER BY ${sql.literal(PRIORITY_ORDER)}, w."updatedAt" DESC, w."id"${limitClause}`
    }

    const loadWorkForChat = (chatId: string) =>
      sql<WorkProjectionRow>`
        SELECT ${projection}
        WHERE r.kind = 'work' AND n.chat_id = ${chatId}
        ORDER BY ${sql.literal(PRIORITY_ORDER)}, r.updated_at DESC, r.id`

    // Delegated work + its current implementer. Inner-join the projection to the
    // *latest* `delegated_to` edge per ref (a re-delegated work keeps only its
    // newest target). The MAX(created_at, id) tie-break makes "latest" total even
    // when two edges share a millisecond. Given a target id, admit only refs whose
    // latest edge points at it ("what is on this implementer right now?"); that id
    // binds as a parameter (it can originate from a tool caller).
    const delegatedWork = (targetSessionId?: string) => {
      const targetFilter =
        targetSessionId !== undefined ? sql`WHERE d.target_session_id = ${targetSessionId}` : sql``
      return sql<DelegatedWorkRow>`
        SELECT w.*, d.target_session_id AS "targetSessionId", d.delegated_at AS "delegatedAt"
        FROM (
          SELECT ${projection}
          WHERE r.kind = 'work'
        ) AS w
        JOIN (
          SELECT e.from_id AS from_id, e.to_id AS target_session_id, e.created_at AS delegated_at
          FROM graph_edge e
          WHERE e.type = 'delegated_to'
            AND (e.created_at, e.id) = (
              SELECT e2.created_at, e2.id FROM graph_edge e2
              WHERE e2.from_id = e.from_id AND e2.type = 'delegated_to'
              ORDER BY e2.created_at DESC, e2.id DESC LIMIT 1
            )
        ) AS d ON d.from_id = w."id"
        ${targetFilter}
        ORDER BY ${sql.literal(PRIORITY_ORDER)}, d.delegated_at DESC, w."id"`
    }

    const loadDelegatedWork = delegatedWork()

    const loadDelegatedWorkForTarget = (targetSessionId: string) => delegatedWork(targetSessionId)

    // For a ref endpoint, join the cited ref to read its real `kind` rather than
    // assuming 'work' — so a future second ref kind decodes correctly. External
    // locators have no ref row; `refKind` is null and the `kind:target` decodes.
    const loadCitations = (refId: string) =>
      sql<{ toKind: string; target: string; note: string | null; refKind: string | null }>`
        SELECT e.to_kind AS "toKind", e.to_id AS "target", e.note AS "note", r.kind AS "refKind"
        FROM graph_edge e
        LEFT JOIN graph_ref r ON r.id = e.to_id AND e.to_kind = 'ref'
        WHERE e.from_id = ${refId} AND e.type IN ('references', 'derived_from')
        ORDER BY e.created_at, e.id`

    const loadEdges = (fromId: string, type: string) =>
      sql<WorkEdgeRow>`SELECT * FROM graph_edge
        WHERE from_id = ${fromId} AND type = ${type}
        ORDER BY created_at, id`

    const insertComment = (c: WorkCommentRow) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`INSERT INTO work_comment ${sql.insert({
            id: c.id,
            workRefId: c.workRefId,
            subjectKind: c.subjectKind,
            subjectId: c.subjectId,
            body: c.body,
            actor: c.actor,
            sessionId: c.sessionId,
            chatId: c.chatId,
            workspaceId: c.workspaceId,
            deviceId: c.deviceId,
            observedSource: c.observedSource,
            executionJson: c.executionJson,
            createdAt: c.createdAt,
            schemaVersion: c.schemaVersion,
          })}`
          // A comment is recent activity on the work — bump the ref's recency the
          // same way `recordEdge` does, so fresh implementer feedback keeps the
          // work out of the monitoring projection's stale bucket (and ahead in the
          // recency-ordered queues). Never moves it backwards: a late-arriving
          // out-of-order comment must not rewind a newer signal's timestamp.
          yield* sql`UPDATE graph_ref SET updated_at = ${c.createdAt}
            WHERE id = ${c.workRefId} AND updated_at < ${c.createdAt}`
        }),
      )

    const loadComments = (workRefId: string) =>
      sql<WorkCommentRow>`SELECT
          id AS "id",
          work_ref_id AS "workRefId",
          subject_kind AS "subjectKind",
          subject_id AS "subjectId",
          body AS "body",
          actor AS "actor",
          session_id AS "sessionId",
          chat_id AS "chatId",
          workspace_id AS "workspaceId",
          device_id AS "deviceId",
          observed_source AS "observedSource",
          execution_json AS "executionJson",
          created_at AS "createdAt",
          schema_version AS "schemaVersion"
        FROM work_comment
        WHERE work_ref_id = ${workRefId}
        ORDER BY created_at, id`

    const insertSummary = (row: SummaryNodeRow) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const inserted = yield* sql<{ id: string }>`INSERT INTO graph_node ${sql.insert({
            id: row.id,
            kind: "summary",
            contentHash: row.inputHash,
            title: "Chat summary",
            body: row.body,
            labelsJson: "[]",
            // Inert for a summary node — no ref, no status_set edge, never read by
            // the work projection — but the column is NOT NULL, so a neutral literal.
            status: "final",
            actor: null,
            sessionId: null,
            chatId: row.chatId,
            workspaceId: row.workspaceId,
            deviceId: null,
            observedSource: "rpc",
            executionJson: null,
            summaryJson: JSON.stringify({
              model: row.model,
              promptVersion: row.promptVersion,
              promptTokens: row.promptTokens,
              completionTokens: row.completionTokens,
              durationMs: row.durationMs,
            }),
            createdAt: row.createdAt,
            schemaVersion: WORK_SCHEMA_VERSION,
          })} ON CONFLICT DO NOTHING RETURNING id`
          // Lost the idempotency race: an identical-key summary already exists.
          // Skip the edge and report the no-op so the caller returns the winner.
          if (inserted.length === 0) return false
          yield* sql`INSERT INTO graph_edge ${sql.insert({
            id: newArcId("work_edge"),
            type: "summarizes",
            fromKind: "node",
            fromId: row.id,
            toKind: "external",
            toId: row.chatId,
            family: "provenance",
            source: "observed",
            confidence: "high",
            note: null,
            actor: null,
            sessionId: null,
            workspaceId: row.workspaceId,
            observedSource: "rpc",
            createdAt: row.createdAt,
            schemaVersion: WORK_SCHEMA_VERSION,
          })}`
          return true
        }),
      )

    const summarySelect = sql`
        id AS "id",
        chat_id AS "chatId",
        workspace_id AS "workspaceId",
        body AS "body",
        content_hash AS "inputHash",
        summary_json AS "summaryJson",
        created_at AS "createdAt"
      FROM graph_node`

    const loadSummaryByKey = (key: SummaryKey) =>
      Effect.map(
        sql<SummaryRawRow>`SELECT ${summarySelect}
          WHERE kind = 'summary' AND chat_id = ${key.chatId} AND content_hash = ${key.inputHash}
            AND json_extract(summary_json, '$.model') = ${key.model}
            AND json_extract(summary_json, '$.promptVersion') = ${key.promptVersion}
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        (rows) => (rows[0] ? toSummaryRow(rows[0]) : null),
      )

    const loadLatestSummaryForChat = (chatId: string) =>
      Effect.map(
        sql<SummaryRawRow>`SELECT ${summarySelect}
          WHERE kind = 'summary' AND chat_id = ${chatId}
          ORDER BY created_at DESC, id DESC
          LIMIT 1`,
        (rows) => (rows[0] ? toSummaryRow(rows[0]) : null),
      )

    return {
      createWork,
      applyRevision,
      recordEdge,
      loadOpenWork,
      loadAllWork,
      loadWork,
      searchWork,
      loadWorkForChat,
      loadDelegatedWork,
      loadDelegatedWorkForTarget,
      loadCitations,
      loadEdges,
      insertComment,
      loadComments,
      insertSummary,
      loadSummaryByKey,
      loadLatestSummaryForChat,
    } as const
  }),
)
