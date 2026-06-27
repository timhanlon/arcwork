import { describe, expect, it } from "vitest"
import {
  commentSearchBackfill,
  graphRefSearchAiTrigger,
  graphRefSearchAuTrigger,
  latestStatus,
  refreshCommentStatusBackfill,
  workCommentSearchAiTrigger,
  workSearchBackfill,
} from "../src/main/work/work-sql.js"

/**
 * Pins the generated DDL of every search-document builder. The builders compose
 * the migration triggers (work/schema.ts) and the read projection's status
 * expression (work/store.ts) from one definition each; behavioural correctness
 * is covered by the read-service search tests. This snapshot is the drift guard:
 * because the migrator never re-runs a shipped migration, an accidental change
 * to a builder would silently alter only *fresh-install* DDL — these snapshots
 * fail loudly instead. Update them only alongside a deliberate, new migration.
 */
describe("work search SQL builders", () => {
  it("latestStatus: status_set edge with the node fallback", () => {
    expect(latestStatus("r.id")).toMatchInlineSnapshot(`
      "COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = r.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status)"
    `)
  })

  it("latestStatus: explicit fallback expression", () => {
    expect(
      latestStatus("new.id", "(SELECT n.status FROM graph_node n WHERE n.id = new.current_node_id)"),
    ).toMatchInlineSnapshot(`
      "COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), (SELECT n.status FROM graph_node n WHERE n.id = new.current_node_id))"
    `)
  })

  it("graph_ref_search_ai (with and without IF NOT EXISTS)", () => {
    expect(graphRefSearchAiTrigger({ ifNotExists: true })).toMatchInlineSnapshot(`
      "CREATE TRIGGER IF NOT EXISTS graph_ref_search_ai AFTER INSERT ON graph_ref
        WHEN new.kind = 'work' AND new.current_node_id IS NOT NULL
        BEGIN
          INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'work:' || new.id,
          new.id,
          'work',
          'work',
          NULL,
          n.chat_id,
          COALESCE(n.workspace_id, new.workspace_id),
          n.title,
          n.body,
          n.labels_json || ' ' || COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          new.created_at,
          new.updated_at
        FROM graph_node n
          WHERE n.id = new.current_node_id;
        END"
    `)
    expect(graphRefSearchAiTrigger({ ifNotExists: false })).toMatchInlineSnapshot(`
      "CREATE TRIGGER graph_ref_search_ai AFTER INSERT ON graph_ref
        WHEN new.kind = 'work' AND new.current_node_id IS NOT NULL
        BEGIN
          INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'work:' || new.id,
          new.id,
          'work',
          'work',
          NULL,
          n.chat_id,
          COALESCE(n.workspace_id, new.workspace_id),
          n.title,
          n.body,
          n.labels_json || ' ' || COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          new.created_at,
          new.updated_at
        FROM graph_node n
          WHERE n.id = new.current_node_id;
        END"
    `)
  })

  it("graph_ref_search_au (plain, and with the 0007 comment-status refresh)", () => {
    expect(
      graphRefSearchAuTrigger({ ifNotExists: false, refreshCommentStatus: false }),
    ).toMatchInlineSnapshot(`
      "CREATE TRIGGER graph_ref_search_au AFTER UPDATE OF current_node_id, updated_at ON graph_ref
        WHEN new.kind = 'work' AND new.current_node_id IS NOT NULL
        BEGIN
          INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'work:' || new.id,
          new.id,
          'work',
          'work',
          NULL,
          n.chat_id,
          COALESCE(n.workspace_id, new.workspace_id),
          n.title,
          n.body,
          n.labels_json || ' ' || COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          new.created_at,
          new.updated_at
        FROM graph_node n
          WHERE n.id = new.current_node_id;
        END"
    `)
    expect(
      graphRefSearchAuTrigger({ ifNotExists: false, refreshCommentStatus: true }),
    ).toMatchInlineSnapshot(`
      "CREATE TRIGGER graph_ref_search_au AFTER UPDATE OF current_node_id, updated_at ON graph_ref
        WHEN new.kind = 'work' AND new.current_node_id IS NOT NULL
        BEGIN
          INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'work:' || new.id,
          new.id,
          'work',
          'work',
          NULL,
          n.chat_id,
          COALESCE(n.workspace_id, new.workspace_id),
          n.title,
          n.body,
          n.labels_json || ' ' || COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          new.created_at,
          new.updated_at
        FROM graph_node n
          WHERE n.id = new.current_node_id;
          UPDATE search_document
            SET status = COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), (SELECT n.status FROM graph_node n WHERE n.id = new.current_node_id))
            WHERE ref = new.id AND source_kind = 'comment';
        END"
    `)
  })

  it("work_comment_search_ai (0003/0004 new.kind, and 0008 empty metadata)", () => {
    expect(
      workCommentSearchAiTrigger({ ifNotExists: true, metadataText: "new.kind" }),
    ).toMatchInlineSnapshot(`
      "CREATE TRIGGER IF NOT EXISTS work_comment_search_ai AFTER INSERT ON work_comment BEGIN
          INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'comment:' || new.id,
          new.work_ref_id,
          'work',
          'comment',
          new.work_ref_id,
          COALESCE(new.chat_id, n.chat_id),
          COALESCE(new.workspace_id, n.workspace_id, r.workspace_id),
          n.title,
          new.body,
          new.kind,
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.work_ref_id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          new.created_at,
          new.created_at
        FROM graph_ref r
          JOIN graph_node n ON n.id = r.current_node_id
          WHERE r.id = new.work_ref_id;
        END"
    `)
    expect(
      workCommentSearchAiTrigger({ ifNotExists: false, metadataText: "''" }),
    ).toMatchInlineSnapshot(`
      "CREATE TRIGGER work_comment_search_ai AFTER INSERT ON work_comment BEGIN
          INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'comment:' || new.id,
          new.work_ref_id,
          'work',
          'comment',
          new.work_ref_id,
          COALESCE(new.chat_id, n.chat_id),
          COALESCE(new.workspace_id, n.workspace_id, r.workspace_id),
          n.title,
          new.body,
          '',
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = new.work_ref_id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          new.created_at,
          new.created_at
        FROM graph_ref r
          JOIN graph_node n ON n.id = r.current_node_id
          WHERE r.id = new.work_ref_id;
        END"
    `)
  })

  it("backfills: work, comment, and comment-status refresh", () => {
    expect(workSearchBackfill()).toMatchInlineSnapshot(`
      "INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'work:' || r.id,
          r.id,
          'work',
          'work',
          NULL,
          n.chat_id,
          COALESCE(n.workspace_id, r.workspace_id),
          n.title,
          n.body,
          n.labels_json || ' ' || COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = r.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = r.id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          r.created_at,
          r.updated_at
        FROM graph_ref r
        JOIN graph_node n ON n.id = r.current_node_id
        WHERE r.kind = 'work'"
    `)
    expect(commentSearchBackfill("c.kind")).toMatchInlineSnapshot(`
      "INSERT OR REPLACE INTO search_document(
          id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
          labels_json, status, created_at, updated_at
        )
        SELECT
          'comment:' || c.id,
          c.work_ref_id,
          'work',
          'comment',
          c.work_ref_id,
          COALESCE(c.chat_id, n.chat_id),
          COALESCE(c.workspace_id, n.workspace_id, r.workspace_id),
          n.title,
          c.body,
          c.kind,
          n.labels_json,
          COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = c.work_ref_id AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), n.status),
          c.created_at,
          c.created_at
        FROM work_comment c
        JOIN graph_ref r ON r.id = c.work_ref_id
        JOIN graph_node n ON n.id = r.current_node_id"
    `)
    expect(refreshCommentStatusBackfill()).toMatchInlineSnapshot(`
      "UPDATE search_document
            SET status = COALESCE((
          SELECT se.to_id FROM graph_edge se
          WHERE se.from_id = search_document.ref AND se.type = 'status_set'
          ORDER BY se.created_at DESC, se.id DESC LIMIT 1
        ), (
              SELECT n.status FROM graph_ref r
              JOIN graph_node n ON n.id = r.current_node_id
              WHERE r.id = search_document.ref
            ))
            WHERE source_kind = 'comment'"
    `)
  })
})
