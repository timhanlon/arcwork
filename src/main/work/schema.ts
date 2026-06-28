/**
 * The forward-only document-graph substrate, scoped to **work** in v0.
 *
 * Three durable shapes from the proposal, made cloud/multiplayer-ready from day
 * one: immutable revision **nodes**, mutable **refs** (the durable identity that
 * points at a node), and typed **edges**. Refs move by an append-only
 * `graph_ref_update` log; nothing is updated in place except `graph_ref`'s
 * current pointer. IDs are globally stable TypeIDs — paths/locations are labels,
 * never identity.
 *
 * Row types are camelCase; the SqliteClient's camel<->snake transforms map them
 * onto the snake_case columns below (same pattern as `db/schema.ts`).
 */

import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { ChatId, CommentId, WorkEdgeId, WorkId, WorkRevId, WorkspaceId } from "../../shared/ids.js"
import { sqlMigration, type Migrations } from "../db/migrator.js"
import {
  commentSearchBackfill,
  graphRefSearchAiTrigger,
  graphRefSearchAuTrigger,
  refreshCommentStatusBackfill,
  workCommentSearchAiTrigger,
  workSearchBackfill,
} from "./work-sql.js"

const addSearchDocumentWorkspaceColumn = Effect.gen(function* () {
  const sql = yield* SqlClient
  const columns = yield* sql.unsafe<{ name: string }>("PRAGMA table_info(search_document)")
  if (!columns.some((column) => column.name === "workspace_id")) {
    yield* sql.unsafe("ALTER TABLE search_document ADD COLUMN workspace_id TEXT")
  }
})

const sqlMigrationAfterWorkspaceColumn = (
  ...statements: ReadonlyArray<string>
) =>
  addSearchDocumentWorkspaceColumn.pipe(
    Effect.andThen(sqlMigration(...statements)),
  )

const backfillWorkWorkspaceFromChat = Effect.gen(function* () {
  const sql = yield* SqlClient
  const tables = yield* sql.unsafe<{ name: string }>("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'chats'")
  if (tables.length === 0) return
  yield* sql.unsafe(`UPDATE graph_node
      SET workspace_id = (
        SELECT chats.workspace_id FROM chats WHERE chats.id = graph_node.chat_id
      )
      WHERE workspace_id IS NULL
        AND chat_id IS NOT NULL
        AND EXISTS (SELECT 1 FROM chats WHERE chats.id = graph_node.chat_id)`)
  yield* sql.unsafe(`UPDATE graph_ref
      SET workspace_id = (
        SELECT graph_node.workspace_id
        FROM graph_node
        WHERE graph_node.id = graph_ref.current_node_id
      )
      WHERE workspace_id IS NULL
        AND current_node_id IS NOT NULL
        AND EXISTS (
          SELECT 1 FROM graph_node
          WHERE graph_node.id = graph_ref.current_node_id
            AND graph_node.workspace_id IS NOT NULL
        )`)
  yield* sql.unsafe(`UPDATE graph_edge
      SET workspace_id = (
        SELECT graph_ref.workspace_id
        FROM graph_ref
        WHERE graph_ref.id = graph_edge.from_id
      )
      WHERE workspace_id IS NULL
        AND from_kind = 'ref'
        AND EXISTS (
          SELECT 1 FROM graph_ref
          WHERE graph_ref.id = graph_edge.from_id
            AND graph_ref.workspace_id IS NOT NULL
        )`)
  yield* sql.unsafe(`UPDATE work_comment
      SET workspace_id = (
        SELECT COALESCE(graph_node.workspace_id, graph_ref.workspace_id)
        FROM graph_ref
        JOIN graph_node ON graph_node.id = graph_ref.current_node_id
        WHERE graph_ref.id = work_comment.work_ref_id
      )
      WHERE workspace_id IS NULL
        AND EXISTS (
          SELECT 1 FROM graph_ref
          JOIN graph_node ON graph_node.id = graph_ref.current_node_id
          WHERE graph_ref.id = work_comment.work_ref_id
            AND COALESCE(graph_node.workspace_id, graph_ref.workspace_id) IS NOT NULL
        )`)
  yield* sql.unsafe(`UPDATE search_document
      SET workspace_id = (
        SELECT COALESCE(n.workspace_id, r.workspace_id)
        FROM graph_ref r
        JOIN graph_node n ON n.id = r.current_node_id
        WHERE r.id = search_document.ref
      )
      WHERE kind = 'work'`)
  yield* sql.unsafe("INSERT INTO search_document_fts(search_document_fts) VALUES ('rebuild')")
})

/** One frozen revision of a unit of work. Addressed by stable id + content hash. */
export interface WorkNodeRow {
  readonly id: WorkRevId
  readonly kind: string // 'work'
  readonly contentHash: string
  readonly title: string
  readonly body: string
  readonly labelsJson: string // JSON string[]
  // The author's stated status at creation (immutable). Current status is NOT
  // read from here on a flip — it is the latest `status_set` edge on the ref;
  // this is only the fallback when no status event exists. Status changes never
  // rewrite this node (content and workflow facts are kept apart).
  readonly status: string
  readonly actor: string | null
  readonly sessionId: string | null
  readonly chatId: ChatId | null
  readonly workspaceId: WorkspaceId | null
  readonly deviceId: string | null
  readonly observedSource: string // 'cli' | 'rpc' | ...
  // Observed execution runtime (harness/model) of the authoring session, as a
  // JSON-encoded `WorkExecution`; null when unknown. Nested rather than flat
  // columns so the runtime story can grow without per-detail schema churn.
  readonly executionJson: string | null
  readonly createdAt: string
  readonly schemaVersion: number
}

/** The durable identity of a unit of work; points at its current revision. */
export interface WorkRefRow {
  readonly id: WorkId
  readonly kind: string // 'work'
  readonly currentNodeId: WorkRevId | null
  readonly displayName: string | null
  readonly location: string | null
  readonly actor: string | null
  readonly workspaceId: WorkspaceId | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly schemaVersion: number
}

/** Append-only log of ref pointer moves — CAS-shaped via `oldNodeId`. */
export interface WorkRefUpdateRow {
  readonly id: WorkEdgeId // shares the edge id-space
  readonly refId: WorkId
  readonly oldNodeId: WorkRevId | null
  readonly newNodeId: WorkRevId
  readonly actor: string | null
  readonly sessionId: string | null
  readonly workspaceId: WorkspaceId | null
  readonly deviceId: string | null
  readonly observedSource: string
  readonly createdAt: string
  readonly schemaVersion: number
}

/** A typed relationship between nodes/refs/externals, carrying source+confidence.
 * Also models append-only workflow *events* — a `status_set` edge points the ref
 * at a status literal (`to_kind='external'`, `to_id='done'`); the latest wins. */
export interface WorkEdgeRow {
  readonly id: WorkEdgeId
  readonly type: string // created_in_session | references | status_set | priority_set | ...
  readonly fromKind: string // node | ref | external
  readonly fromId: string // polymorphic: a node/ref id or an external locator, per fromKind
  readonly toKind: string // node | ref | external
  readonly toId: string // polymorphic: a node/ref id or an external locator, per toKind
  readonly family: string // provenance | live | workflow
  readonly source: string // observed | inferred | user_confirmed | legacy
  readonly confidence: string // high | medium | low
  readonly note: string | null
  readonly actor: string | null
  readonly sessionId: string | null
  readonly workspaceId: WorkspaceId | null
  readonly observedSource: string
  readonly createdAt: string
  readonly schemaVersion: number
}

/** A comment on a unit of work, anchored to a revision node or the ref itself.
 * `workRefId` is denormalized (a comment on a node also records which ref the
 * node belongs to) so comments list by work id with a single indexed query. */
export interface WorkCommentRow {
  readonly id: CommentId
  readonly workRefId: WorkId
  readonly subjectKind: string // node | ref
  readonly subjectId: string // a graph_node id (node) or graph_ref id (ref), per subjectKind
  readonly body: string
  readonly actor: string | null
  readonly sessionId: string | null
  readonly chatId: ChatId | null
  readonly workspaceId: WorkspaceId | null
  readonly deviceId: string | null
  readonly observedSource: string
  // Observed execution runtime (harness/model) of the commenting session, as a
  // JSON-encoded `WorkExecution`; null when unknown. Mirrors the node column.
  readonly executionJson: string | null
  readonly createdAt: string
  readonly schemaVersion: number
}

/** The flattened ref+current-node row a queue/detail projection reads. */
export interface WorkProjectionRow {
  readonly id: WorkId // ref id
  readonly nodeId: WorkRevId
  readonly title: string
  readonly body: string
  readonly labelsJson: string
  readonly status: string
  // Derived latest `priority_set`; null when unset (no node fallback, unlike status).
  readonly priority: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly actor: string | null
  readonly sessionId: string | null
  readonly chatId: ChatId | null
  readonly workspaceId: WorkspaceId | null
  readonly observedSource: string
  // JSON-encoded `WorkExecution` from the current node; null when unknown.
  readonly executionJson: string | null
}

export const WORK_SCHEMA_VERSION = 1

/**
 * Versioned migrations for the work-graph substrate, keyed `"<id>_<name>"` and
 * run by the {@link runMigrations} ledger (table `work_migrations`).
 * `0001_initial` is the current development baseline — tables before indexes,
 * with `IF NOT EXISTS` so re-opening a current DB is harmless. Add future
 * changes as new `"NNNN_*"` keys of forward DDL — see migrator.ts.
 */
export const workMigrations: Migrations = {
  "0001_initial": sqlMigration(
    `CREATE TABLE IF NOT EXISTS graph_node (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    labels_json TEXT NOT NULL,
    status TEXT NOT NULL,
    actor TEXT,
    session_id TEXT,
    chat_id TEXT,
    workspace_id TEXT,
    device_id TEXT,
    observed_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_ref (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    current_node_id TEXT REFERENCES graph_node(id),
    display_name TEXT,
    location TEXT,
    actor TEXT,
    workspace_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_ref_update (
    id TEXT PRIMARY KEY,
    ref_id TEXT NOT NULL REFERENCES graph_ref(id),
    old_node_id TEXT,
    new_node_id TEXT NOT NULL REFERENCES graph_node(id),
    actor TEXT,
    session_id TEXT,
    workspace_id TEXT,
    device_id TEXT,
    observed_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS graph_edge (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    from_kind TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_kind TEXT NOT NULL,
    to_id TEXT NOT NULL,
    family TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence TEXT NOT NULL,
    note TEXT,
    actor TEXT,
    session_id TEXT,
    workspace_id TEXT,
    observed_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS graph_ref_kind ON graph_ref(kind, updated_at, id)`,
  `CREATE INDEX IF NOT EXISTS graph_ref_update_ref ON graph_ref_update(ref_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS graph_edge_from ON graph_edge(from_id, type)`,
  `CREATE INDEX IF NOT EXISTS graph_edge_to ON graph_edge(to_id, type)`,
  ),
  // Comments live in their own table rather than as nodes/edges: they are append-
  // only annotations, not revisable content, and `work_ref_id` lets us list a
  // work's whole comment history with one indexed scan. `subject_id` is the node
  // (default) or ref the comment hangs off — so a comment stays with the exact
  // revision it discussed even after the work is revised.
  "0002_comments": sqlMigration(
    `CREATE TABLE IF NOT EXISTS work_comment (
    id TEXT PRIMARY KEY,
    work_ref_id TEXT NOT NULL REFERENCES graph_ref(id),
    subject_kind TEXT NOT NULL,
    subject_id TEXT NOT NULL,
    body TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT,
    session_id TEXT,
    chat_id TEXT,
    workspace_id TEXT,
    device_id TEXT,
    observed_source TEXT NOT NULL,
    created_at TEXT NOT NULL,
    schema_version INTEGER NOT NULL
    )`,
    `CREATE INDEX IF NOT EXISTS work_comment_ref ON work_comment(work_ref_id, created_at, id)`,
  ),
  "0003_search_documents_work": sqlMigration(
    `CREATE TABLE IF NOT EXISTS search_document (
    id TEXT PRIMARY KEY,
    ref TEXT NOT NULL,
    kind TEXT NOT NULL,
    source_kind TEXT NOT NULL,
    parent_ref TEXT,
    chat_id TEXT,
    workspace_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL,
    metadata_text TEXT NOT NULL,
    labels_json TEXT NOT NULL DEFAULT '[]',
    status TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
    `CREATE INDEX IF NOT EXISTS search_document_kind_updated ON search_document(kind, updated_at, id)`,
    `CREATE INDEX IF NOT EXISTS search_document_workspace ON search_document(workspace_id, kind, updated_at, id)`,
    `CREATE INDEX IF NOT EXISTS search_document_chat ON search_document(chat_id, kind, updated_at, id)`,
    `CREATE INDEX IF NOT EXISTS search_document_parent ON search_document(parent_ref, source_kind, updated_at, id)`,
    `CREATE VIRTUAL TABLE IF NOT EXISTS search_document_fts USING fts5(
    title,
    body,
    metadata_text,
    content='search_document',
    content_rowid='rowid',
    tokenize='unicode61'
  )`,
    `CREATE TRIGGER IF NOT EXISTS search_document_ai AFTER INSERT ON search_document BEGIN
    INSERT INTO search_document_fts(rowid, title, body, metadata_text)
    VALUES (new.rowid, new.title, new.body, new.metadata_text);
  END`,
    `CREATE TRIGGER IF NOT EXISTS search_document_ad AFTER DELETE ON search_document BEGIN
    INSERT INTO search_document_fts(search_document_fts, rowid, title, body, metadata_text)
    VALUES ('delete', old.rowid, old.title, old.body, old.metadata_text);
  END`,
    `CREATE TRIGGER IF NOT EXISTS search_document_au AFTER UPDATE ON search_document BEGIN
    INSERT INTO search_document_fts(search_document_fts, rowid, title, body, metadata_text)
    VALUES ('delete', old.rowid, old.title, old.body, old.metadata_text);
    INSERT INTO search_document_fts(rowid, title, body, metadata_text)
    VALUES (new.rowid, new.title, new.body, new.metadata_text);
  END`,
    graphRefSearchAiTrigger({ ifNotExists: true }),
    graphRefSearchAuTrigger({ ifNotExists: true, refreshCommentStatus: false }),
    `CREATE TRIGGER IF NOT EXISTS graph_ref_search_ad AFTER DELETE ON graph_ref BEGIN
    DELETE FROM search_document WHERE id = 'work:' || old.id OR parent_ref = old.id;
  END`,
    `CREATE TRIGGER IF NOT EXISTS graph_edge_search_workflow_ai AFTER INSERT ON graph_edge
  WHEN new.type IN ('status_set', 'priority_set')
  BEGIN
    UPDATE graph_ref SET updated_at = MAX(updated_at, new.created_at)
    WHERE id = new.from_id AND kind = 'work';
  END`,
    workCommentSearchAiTrigger({ ifNotExists: true, metadataText: "new.kind" }),
    `CREATE TRIGGER IF NOT EXISTS work_comment_search_ad AFTER DELETE ON work_comment BEGIN
    DELETE FROM search_document WHERE id = 'comment:' || old.id;
  END`,
    workSearchBackfill(),
    commentSearchBackfill("c.kind"),
    `INSERT INTO search_document_fts(search_document_fts) VALUES ('rebuild')`,
  ),
  "0004_search_documents_workspace": sqlMigrationAfterWorkspaceColumn(
    `CREATE INDEX IF NOT EXISTS search_document_workspace ON search_document(workspace_id, kind, updated_at, id)`,
    `DROP TRIGGER graph_ref_search_ai`,
    `DROP TRIGGER graph_ref_search_au`,
    `DROP TRIGGER work_comment_search_ai`,
    graphRefSearchAiTrigger({ ifNotExists: false }),
    graphRefSearchAuTrigger({ ifNotExists: false, refreshCommentStatus: false }),
    workCommentSearchAiTrigger({ ifNotExists: false, metadataText: "new.kind" }),
    `UPDATE search_document
      SET workspace_id = (
        SELECT COALESCE(n.workspace_id, r.workspace_id)
        FROM graph_ref r
        JOIN graph_node n ON n.id = r.current_node_id
        WHERE r.id = search_document.ref
      )
      WHERE kind = 'work'`,
    `INSERT INTO search_document_fts(search_document_fts) VALUES ('rebuild')`,
  ),
  "0005_backfill_work_workspace_from_chat": backfillWorkWorkspaceFromChat,
  // Observed execution provenance (harness + model), JSON-encoded per row. One
  // nullable column on the two tables a work/comment projection reads provenance
  // off — the node (current-revision authorship) and the comment. Edges and
  // ref-updates carry routing ids only and no read path surfaces execution from
  // them, so they stay untouched.
  "0006_execution_provenance": sqlMigration(
    `ALTER TABLE graph_node ADD COLUMN execution_json TEXT`,
    `ALTER TABLE work_comment ADD COLUMN execution_json TEXT`,
  ),
  // A work projects one `work:` ref row plus one `comment:` row per comment. The
  // comment rows snapshot the work's status at comment time (work_comment_search_ai)
  // and were never refreshed afterward: a status change only rebuilds the ref row
  // (graph_ref_search_au, fired because the status_set edge bumps
  // graph_ref.updated_at). So a work commented-on while open and later closed kept
  // a stale open/active comment row, and the open-queue search
  // (`status IN ('open','active','blocked')`) re-surfaced the closed work
  // (`work_01kvbtwgdjf…`, `work_01kv7fj9…`, +4). Refresh comment-row status in the
  // same trigger that already refreshes the ref row, then backfill existing rows.
  "0007_refresh_comment_status_on_status_change": sqlMigration(
    `DROP TRIGGER graph_ref_search_au`,
    graphRefSearchAuTrigger({ ifNotExists: false, refreshCommentStatus: true }),
    refreshCommentStatusBackfill(),
  ),
  // Comment `kind` (comment/review/decision-note) was a write-only vocabulary —
  // no read path or UI ever branched on it. Cut to a single comment type before
  // the OSS release. Recreate the comment→search_document trigger without the
  // column (metadata_text becomes empty for comment rows), then drop it.
  "0008_drop_comment_kind": sqlMigration(
    `DROP TRIGGER work_comment_search_ai`,
    workCommentSearchAiTrigger({ ifNotExists: false, metadataText: "''" }),
    `ALTER TABLE work_comment DROP COLUMN kind`,
  ),
}
