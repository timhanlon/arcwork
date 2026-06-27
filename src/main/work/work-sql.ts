/**
 * Hand-built SQL fragments shared by the work graph's read projection
 * (`work/store.ts`) and its `search_document` denormalisation triggers
 * (`work/schema.ts`).
 *
 * Two kinds of duplication live here as one definition each:
 *  - "the current status of a work ref" ({@link latestStatus}) — the latest
 *    `status_set` edge, else the node's authored status — which the projection
 *    and every search trigger compute identically; and
 *  - the `INSERT … SELECT` bodies the triggers restate across several migrations
 *    (SQLite has no `ALTER TRIGGER`, so each change re-`CREATE`s the whole
 *    trigger).
 *
 * These are raw SQL strings, not Effect `sql` fragments, because the triggers
 * are **parameter-free DDL** — there is nothing to bind, so a string is the
 * direct tool. The store interpolates {@link latestStatus} into its typed `sql`
 * template via `sql.literal`. Every argument here is trusted, literal SQL (a
 * column reference like `r.id` / `new.id`) — never user input.
 *
 * Safety: the generated trigger DDL is behaviourally identical to the literal
 * triggers it replaced (the read-service search tests exercise it), and
 * `work-sql.test.ts` pins each builder's output so a later edit can't silently
 * change fresh-install DDL. Existing databases never re-run a shipped migration
 * regardless of its text, so this only ever affects fresh installs.
 */

/**
 * The current status of a work ref: the latest `status_set` edge, falling back
 * to `fallback` (the joined node's authored `status` for projections/inserts).
 * `ref` and `fallback` are literal SQL — a column reference, never user input.
 */
export const latestStatus = (ref: string, fallback = "n.status"): string =>
  `COALESCE((
    SELECT se.to_id FROM graph_edge se
    WHERE se.from_id = ${ref} AND se.type = 'status_set'
    ORDER BY se.created_at DESC, se.id DESC LIMIT 1
  ), ${fallback})`

/** The `search_document` column list every work/comment upsert writes. */
const SEARCH_DOCUMENT_COLUMNS = `id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
    labels_json, status, created_at, updated_at`

/**
 * Project a work ref + its current node into `search_document`. `row` is the
 * source ref alias (`new` in a `graph_ref` trigger, `r` in a backfill); `from`
 * is the matching FROM/WHERE that binds the current node as `n`.
 */
export const workSearchUpsert = (row: string, from: string): string =>
  `INSERT OR REPLACE INTO search_document(
    ${SEARCH_DOCUMENT_COLUMNS}
  )
  SELECT
    'work:' || ${row}.id,
    ${row}.id,
    'work',
    'work',
    NULL,
    n.chat_id,
    COALESCE(n.workspace_id, ${row}.workspace_id),
    n.title,
    n.body,
    n.labels_json || ' ' || ${latestStatus(`${row}.id`)},
    n.labels_json,
    ${latestStatus(`${row}.id`)},
    ${row}.created_at,
    ${row}.updated_at
  ${from}`

/**
 * Project a comment row into `search_document`. `row` is the comment alias
 * (`new` in the trigger, `c` in a backfill); `metadataText` is the
 * `metadata_text` expression; `from` binds the work's current node as `n` and
 * its ref as `r`.
 */
export const commentSearchUpsert = (row: string, metadataText: string, from: string): string =>
  `INSERT OR REPLACE INTO search_document(
    ${SEARCH_DOCUMENT_COLUMNS}
  )
  SELECT
    'comment:' || ${row}.id,
    ${row}.work_ref_id,
    'work',
    'comment',
    ${row}.work_ref_id,
    COALESCE(${row}.chat_id, n.chat_id),
    COALESCE(${row}.workspace_id, n.workspace_id, r.workspace_id),
    n.title,
    ${row}.body,
    ${metadataText},
    n.labels_json,
    ${latestStatus(`${row}.work_ref_id`)},
    ${row}.created_at,
    ${row}.created_at
  ${from}`

/** Full-table reprojection of every work ref into `search_document` — a
 * migration backfill, the row shape {@link workSearchUpsert} writes but scanning
 * all refs rather than firing per ref. */
export const workSearchBackfill = (): string =>
  workSearchUpsert(
    "r",
    `FROM graph_ref r
  JOIN graph_node n ON n.id = r.current_node_id
  WHERE r.kind = 'work'`,
  )

/** Full-table reprojection of every comment into `search_document`. */
export const commentSearchBackfill = (metadataText: string): string =>
  commentSearchUpsert(
    "c",
    metadataText,
    `FROM work_comment c
  JOIN graph_ref r ON r.id = c.work_ref_id
  JOIN graph_node n ON n.id = r.current_node_id`,
  )

const ifNotExists = (on: boolean): string => (on ? "IF NOT EXISTS " : "")

/** The current node the `graph_ref` search triggers project (the trigger fires
 * on the ref row `new`, so the node is joined directly). */
const WORK_TRIGGER_FROM = `FROM graph_node n
    WHERE n.id = new.current_node_id`

/** The work ref + current node a `work_comment` search trigger projects. */
const COMMENT_TRIGGER_FROM = `FROM graph_ref r
    JOIN graph_node n ON n.id = r.current_node_id
    WHERE r.id = new.work_ref_id`

/** `AFTER INSERT` on `graph_ref` → upsert the work's `search_document` row. */
export const graphRefSearchAiTrigger = (opts: { readonly ifNotExists: boolean }): string =>
  `CREATE TRIGGER ${ifNotExists(opts.ifNotExists)}graph_ref_search_ai AFTER INSERT ON graph_ref
  WHEN new.kind = 'work' AND new.current_node_id IS NOT NULL
  BEGIN
    ${workSearchUpsert("new", WORK_TRIGGER_FROM)};
  END`

/**
 * `AFTER UPDATE OF current_node_id, updated_at` on `graph_ref` → re-upsert the
 * work row, and (since `0007`) refresh the snapshotted status on its `comment`
 * rows so a status change can't leave a stale comment row re-surfacing the work.
 */
export const graphRefSearchAuTrigger = (opts: {
  readonly ifNotExists: boolean
  readonly refreshCommentStatus: boolean
}): string => {
  const refreshComments = opts.refreshCommentStatus
    ? `
    UPDATE search_document
      SET status = ${latestStatus(
        "new.id",
        "(SELECT n.status FROM graph_node n WHERE n.id = new.current_node_id)",
      )}
      WHERE ref = new.id AND source_kind = 'comment';`
    : ""
  return `CREATE TRIGGER ${ifNotExists(opts.ifNotExists)}graph_ref_search_au AFTER UPDATE OF current_node_id, updated_at ON graph_ref
  WHEN new.kind = 'work' AND new.current_node_id IS NOT NULL
  BEGIN
    ${workSearchUpsert("new", WORK_TRIGGER_FROM)};${refreshComments}
  END`
}

/** `AFTER INSERT` on `work_comment` → upsert the comment's `search_document`
 * row. `metadataText` is the `metadata_text` expression (`''` since comment
 * kind was dropped in `0008`). */
export const workCommentSearchAiTrigger = (opts: {
  readonly ifNotExists: boolean
  readonly metadataText: string
}): string =>
  `CREATE TRIGGER ${ifNotExists(opts.ifNotExists)}work_comment_search_ai AFTER INSERT ON work_comment BEGIN
    ${commentSearchUpsert("new", opts.metadataText, COMMENT_TRIGGER_FROM)};
  END`

/** Backfill UPDATE that refreshes the snapshotted status on every `comment` row
 * (the one-time companion to {@link graphRefSearchAuTrigger}'s `0007` change). */
export const refreshCommentStatusBackfill = (): string =>
  `UPDATE search_document
      SET status = ${latestStatus(
        "search_document.ref",
        `(
        SELECT n.status FROM graph_ref r
        JOIN graph_node n ON n.id = r.current_node_id
        WHERE r.id = search_document.ref
      )`,
      )}
      WHERE source_kind = 'comment'`
