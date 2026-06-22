/**
 * arc's own domain schema — the durable mirror of what the in-memory stores
 * (`ChatService`, `TargetSessionManager`) hold today. Unlike arc-ingest (which
 * is deliberately domain-free), this store IS arc's domain: chats, target
 * sessions, the chat↔native-session binding, workspace cwd, and lifecycle.
 *
 * Row types are camelCase; the SqliteClient's camel<->snake transforms map them
 * onto the snake_case columns below. `nativeSessionId` is persisted so a resume
 * (or the future auto-resume arc) can recover which native session each chat
 * owned — it does NOT have to resolve against another database for arc to work.
 */

import { Effect } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { ActivityId, ChatId, HookId, MessageId, TargetId, WorkspaceId } from "../../shared/ids.js"
import { sqlMigration, type Migrations } from "./migrator.js"

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

/** One row per workspace (a filesystem root for chats and target cwd). */
export interface WorkspaceRow {
  readonly id: WorkspaceId
  readonly path: string
  readonly name: string
  readonly createdAt: string
  readonly lastOpenedAt: string
}

/** One row per chat (a conversation thread). */
export interface ChatRow {
  readonly id: ChatId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly createdAt: string
}

/** One row per interactive PTY target session, keyed `(chatId, provider)`. */
export interface TargetSessionRow {
  readonly id: TargetId
  readonly chatId: ChatId
  readonly provider: string
  readonly preset: string | null
  readonly cwd: string
  /** discovered after launch via the SessionStart hook; null until bound */
  readonly nativeSessionId: string | null
  readonly nativeTranscriptPath: string | null
  readonly state: string
  readonly startedAt: string
}

/** Hook-projected chat transcript row (upserted by dedup key). */
export interface ChatMessageRow {
  readonly id: MessageId
  readonly chatId: ChatId
  readonly targetSessionId: TargetId | null
  readonly role: string
  readonly turnId: string | null
  readonly messageId: string | null
  readonly chunkIndex: number | null
  readonly body: string
  readonly status: string
  /** model that produced an assistant/subagent row; null for other roles or
   * when the provider's hook did not report it */
  readonly model: string | null
  /** serialized structured payload for request/tool rows; null otherwise */
  readonly requestJson: string | null
  readonly occurredAt: string
  readonly source: string
  readonly dedupKey: string
}

/** Append-only raw hook signal before activity/chat projection. */
export interface RawHookSignalRow {
  readonly id: HookId
  readonly chatId: ChatId | null
  readonly targetSessionId: TargetId | null
  readonly targetProvider: string | null
  readonly resolvedProvider: string
  readonly declaredProvider: string
  readonly declaredEvent: string
  readonly nativeSessionId: string | null
  readonly nativeConversationId: string | null
  readonly nativeTurnId: string | null
  readonly nativeToolUseId: string | null
  readonly nativeHookEventName: string | null
  readonly hookInputSha256: string
  readonly hookInputParseOk: number
  readonly observedAt: string
  readonly receivedAt: string
  readonly payloadJson: string
}

/** Append-only normalized observable facts derived from hook signals. */
export interface ActivityEventRow {
  readonly id: ActivityId
  readonly workspaceRoot: string
  readonly workContextId: ChatId | null
  readonly userActionId: string | null
  readonly targetSessionId: TargetId | null
  readonly source: string
  readonly kind: string
  readonly actor: string | null
  readonly occurredAt: string
  readonly payloadJson: string
  readonly provenanceJson: string
  readonly dedupKey: string | null
}

/**
 * Versioned migrations for arc's domain store, keyed `"<id>_<name>"` and run by
 * the {@link runMigrations} ledger (table `arc_migrations`). `0001_initial` is
 * the current development baseline — tables before indexes, with `IF NOT
 * EXISTS` so re-opening a current DB is harmless. `request_json`/`model` on
 * `chat_messages` are part of the baseline. `ON DELETE CASCADE` needs `PRAGMA
 * foreign_keys = ON`, which the store enables before migrating. Add future
 * changes as new `"NNNN_*"` keys of forward DDL — see migrator.ts.
 */
export const arcMigrations: Migrations = {
  "0001_initial": sqlMigration(
    `CREATE TABLE IF NOT EXISTS workspaces (
    id TEXT PRIMARY KEY,
    path TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    last_opened_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS chats (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS target_sessions (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    preset TEXT,
    cwd TEXT NOT NULL,
    native_session_id TEXT,
    native_transcript_path TEXT,
    state TEXT NOT NULL,
    started_at TEXT NOT NULL,
    UNIQUE(chat_id, provider)
  )`,
  `CREATE INDEX IF NOT EXISTS chats_workspace ON chats(workspace_id, created_at, id)`,
  `CREATE INDEX IF NOT EXISTS target_sessions_chat ON target_sessions(chat_id)`,
  `CREATE INDEX IF NOT EXISTS target_sessions_native ON target_sessions(provider, native_session_id)`,
  `CREATE TABLE IF NOT EXISTS activity_events (
    id TEXT PRIMARY KEY,
    workspace_root TEXT NOT NULL,
    work_context_id TEXT,
    user_action_id TEXT,
    target_session_id TEXT,
    source TEXT NOT NULL,
    kind TEXT NOT NULL,
    actor TEXT,
    occurred_at TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    provenance_json TEXT NOT NULL,
    dedup_key TEXT UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS activity_events_target ON activity_events(target_session_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS activity_events_chat ON activity_events(work_context_id, occurred_at)`,
  `CREATE INDEX IF NOT EXISTS activity_events_kind ON activity_events(kind, occurred_at)`,
  `CREATE TABLE IF NOT EXISTS chat_messages (
    id TEXT PRIMARY KEY,
    chat_id TEXT NOT NULL REFERENCES chats(id) ON DELETE CASCADE,
    target_session_id TEXT,
    role TEXT NOT NULL,
    turn_id TEXT,
    message_id TEXT,
    chunk_index INTEGER,
    body TEXT NOT NULL,
    status TEXT NOT NULL,
    model TEXT,
    request_json TEXT,
    occurred_at TEXT NOT NULL,
    source TEXT NOT NULL,
    dedup_key TEXT NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS chat_messages_chat ON chat_messages(chat_id, occurred_at, id)`,
  `CREATE TABLE IF NOT EXISTS raw_hook_signals (
    id TEXT PRIMARY KEY,
    chat_id TEXT,
    target_session_id TEXT,
    target_provider TEXT,
    resolved_provider TEXT NOT NULL,
    declared_provider TEXT NOT NULL,
    declared_event TEXT NOT NULL,
    native_session_id TEXT,
    native_conversation_id TEXT,
    native_turn_id TEXT,
    native_tool_use_id TEXT,
    native_hook_event_name TEXT,
    hook_input_sha256 TEXT NOT NULL,
    hook_input_parse_ok INTEGER NOT NULL,
    observed_at TEXT NOT NULL,
    received_at TEXT NOT NULL,
    payload_json TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS raw_hook_signals_target ON raw_hook_signals(target_session_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS raw_hook_signals_provider_event ON raw_hook_signals(resolved_provider, declared_event, observed_at)`,
  `CREATE INDEX IF NOT EXISTS raw_hook_signals_native_session ON raw_hook_signals(native_session_id, observed_at)`,
  `CREATE INDEX IF NOT EXISTS raw_hook_signals_tool_use ON raw_hook_signals(native_tool_use_id)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS raw_hook_signals_dedup ON raw_hook_signals(
    target_session_id, hook_input_sha256, declared_provider, declared_event
  )`,
  ),
  // `chat_messages` only had `chat_messages_chat(chat_id, …)`, so every query
  // filtering by `target_session_id` (the per-target reconcile/repair family) and
  // the `role`/`status` pending-request poll full-scanned the table. Two access
  // patterns, two indexes:
  // - `(role, status, target_session_id)` seeks the recurring `loadPendingRequests`
  //   poll and `supersedePendingRequestsForTarget` (a transaction that held the
  //   SQLite permit and blocked launches — see work_01kv4wr6).
  // - `(target_session_id, role)` seeks the per-target assistant/user reconcile,
  //   repair, and absorb statements run on the message hot path.
  "0002_chat_messages_target_indexes": sqlMigration(
    `CREATE INDEX IF NOT EXISTS chat_messages_pending ON chat_messages(role, status, target_session_id)`,
    `CREATE INDEX IF NOT EXISTS chat_messages_target_role ON chat_messages(target_session_id, role)`,
  ),
  "0003_search_documents_arc": sqlMigration(
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
    `CREATE TRIGGER IF NOT EXISTS chats_search_ai AFTER INSERT ON chats BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'chat:' || new.id, new.id, 'chat', 'chat', NULL, new.id, new.workspace_id, new.title, '', '',
      '[]', NULL, new.created_at, new.created_at
    );
  END`,
    `CREATE TRIGGER IF NOT EXISTS chats_search_au AFTER UPDATE OF title ON chats BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'chat:' || new.id, new.id, 'chat', 'chat', NULL, new.id, new.workspace_id, new.title, '', '',
      '[]', NULL, new.created_at, new.created_at
    );
  END`,
    `CREATE TRIGGER IF NOT EXISTS chats_search_ad AFTER DELETE ON chats BEGIN
    DELETE FROM search_document WHERE id = 'chat:' || old.id;
  END`,
    `CREATE TRIGGER IF NOT EXISTS chat_messages_search_ai AFTER INSERT ON chat_messages BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'message:' || new.id,
      new.id,
      'message',
      'message',
      new.chat_id,
      new.chat_id,
      (SELECT workspace_id FROM chats WHERE id = new.chat_id),
      COALESCE(json_extract(new.request_json, '$.toolName'), new.role),
      new.body,
      new.role || ' ' || COALESCE(new.model, '') || ' ' || COALESCE(new.request_json, ''),
      '[]',
      new.status,
      new.occurred_at,
      new.occurred_at
    );
  END`,
    `CREATE TRIGGER IF NOT EXISTS chat_messages_search_au AFTER UPDATE ON chat_messages BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'message:' || new.id,
      new.id,
      'message',
      'message',
      new.chat_id,
      new.chat_id,
      (SELECT workspace_id FROM chats WHERE id = new.chat_id),
      COALESCE(json_extract(new.request_json, '$.toolName'), new.role),
      new.body,
      new.role || ' ' || COALESCE(new.model, '') || ' ' || COALESCE(new.request_json, ''),
      '[]',
      new.status,
      new.occurred_at,
      new.occurred_at
    );
  END`,
    `CREATE TRIGGER IF NOT EXISTS chat_messages_search_ad AFTER DELETE ON chat_messages BEGIN
    DELETE FROM search_document WHERE id = 'message:' || old.id;
  END`,
    `INSERT OR REPLACE INTO search_document(
    id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
    labels_json, status, created_at, updated_at
  )
  SELECT
    'chat:' || id, id, 'chat', 'chat', NULL, id, workspace_id, title, '', '',
    '[]', NULL, created_at, created_at
  FROM chats`,
    `INSERT OR REPLACE INTO search_document(
    id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
    labels_json, status, created_at, updated_at
  )
  SELECT
    'message:' || id,
    id,
    'message',
    'message',
    chat_id,
    chat_id,
    (SELECT workspace_id FROM chats WHERE id = chat_messages.chat_id),
    COALESCE(json_extract(request_json, '$.toolName'), role),
    body,
    role || ' ' || COALESCE(model, '') || ' ' || COALESCE(request_json, ''),
    '[]',
    status,
    occurred_at,
    occurred_at
  FROM chat_messages`,
    `INSERT INTO search_document_fts(search_document_fts) VALUES ('rebuild')`,
  ),
  "0004_search_documents_workspace": sqlMigrationAfterWorkspaceColumn(
    `CREATE INDEX IF NOT EXISTS search_document_workspace ON search_document(workspace_id, kind, updated_at, id)`,
    `DROP TRIGGER chats_search_ai`,
    `DROP TRIGGER chats_search_au`,
    `DROP TRIGGER chat_messages_search_ai`,
    `DROP TRIGGER chat_messages_search_au`,
    `CREATE TRIGGER chats_search_ai AFTER INSERT ON chats BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'chat:' || new.id, new.id, 'chat', 'chat', NULL, new.id, new.workspace_id, new.title, '', '',
      '[]', NULL, new.created_at, new.created_at
    );
  END`,
    `CREATE TRIGGER chats_search_au AFTER UPDATE OF title ON chats BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'chat:' || new.id, new.id, 'chat', 'chat', NULL, new.id, new.workspace_id, new.title, '', '',
      '[]', NULL, new.created_at, new.created_at
    );
  END`,
    `CREATE TRIGGER chat_messages_search_ai AFTER INSERT ON chat_messages BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'message:' || new.id,
      new.id,
      'message',
      'message',
      new.chat_id,
      new.chat_id,
      (SELECT workspace_id FROM chats WHERE id = new.chat_id),
      COALESCE(json_extract(new.request_json, '$.toolName'), new.role),
      new.body,
      new.role || ' ' || COALESCE(new.model, '') || ' ' || COALESCE(new.request_json, ''),
      '[]',
      new.status,
      new.occurred_at,
      new.occurred_at
    );
  END`,
    `CREATE TRIGGER chat_messages_search_au AFTER UPDATE ON chat_messages BEGIN
    INSERT OR REPLACE INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'message:' || new.id,
      new.id,
      'message',
      'message',
      new.chat_id,
      new.chat_id,
      (SELECT workspace_id FROM chats WHERE id = new.chat_id),
      COALESCE(json_extract(new.request_json, '$.toolName'), new.role),
      new.body,
      new.role || ' ' || COALESCE(new.model, '') || ' ' || COALESCE(new.request_json, ''),
      '[]',
      new.status,
      new.occurred_at,
      new.occurred_at
    );
  END`,
    `UPDATE search_document
      SET workspace_id = (
        SELECT workspace_id FROM chats WHERE id = search_document.chat_id
      )
      WHERE kind IN ('chat', 'message')`,
    `INSERT INTO search_document_fts(search_document_fts) VALUES ('rebuild')`,
  ),
  // search_document_fts is external-content (content='search_document',
  // content_rowid='rowid') and is kept in sync only by the search_document
  // ai/ad/au triggers, keyed on the table's integer rowid. The chat/message
  // sync triggers above wrote with `INSERT OR REPLACE INTO search_document`,
  // which resolves the `id` (TEXT PK) conflict as delete-old + insert-new. Two
  // faults compounded: (1) a REPLACE-induced delete does NOT fire
  // search_document_ad unless `PRAGMA recursive_triggers=ON` (it defaults off),
  // so the old row's FTS posting was never removed; (2) the re-inserted row got
  // a fresh rowid (id is the PK, not an INTEGER-PK alias), so search_document_ai
  // appended a posting under a new rowid. Every message update (streaming chunk
  // / status flip) thus orphaned its prior FTS posting — ~13 stale postings per
  // live doc, growing the FTS index unboundedly (only `rebuild`, never
  // `optimize`, could reclaim it). Switching to UPSERT makes the conflict path a
  // real UPDATE: it keeps the rowid stable and fires search_document_au, which
  // deletes the old posting and inserts the new one for the same rowid — FTS
  // stays strictly 1:1 with search_document. The final `rebuild` collapses the
  // already-accumulated orphans (run `VACUUM` once out-of-band to return the
  // freed pages to the OS).
  "0005_search_document_upsert_triggers": sqlMigration(
    `DROP TRIGGER chats_search_ai`,
    `DROP TRIGGER chats_search_au`,
    `DROP TRIGGER chat_messages_search_ai`,
    `DROP TRIGGER chat_messages_search_au`,
    `CREATE TRIGGER chats_search_ai AFTER INSERT ON chats BEGIN
    INSERT INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'chat:' || new.id, new.id, 'chat', 'chat', NULL, new.id, new.workspace_id, new.title, '', '',
      '[]', NULL, new.created_at, new.created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      title = excluded.title,
      updated_at = excluded.updated_at;
  END`,
    `CREATE TRIGGER chats_search_au AFTER UPDATE OF title ON chats BEGIN
    INSERT INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'chat:' || new.id, new.id, 'chat', 'chat', NULL, new.id, new.workspace_id, new.title, '', '',
      '[]', NULL, new.created_at, new.created_at
    )
    ON CONFLICT(id) DO UPDATE SET
      workspace_id = excluded.workspace_id,
      title = excluded.title,
      updated_at = excluded.updated_at;
  END`,
    `CREATE TRIGGER chat_messages_search_ai AFTER INSERT ON chat_messages BEGIN
    INSERT INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'message:' || new.id,
      new.id,
      'message',
      'message',
      new.chat_id,
      new.chat_id,
      (SELECT workspace_id FROM chats WHERE id = new.chat_id),
      COALESCE(json_extract(new.request_json, '$.toolName'), new.role),
      new.body,
      new.role || ' ' || COALESCE(new.model, '') || ' ' || COALESCE(new.request_json, ''),
      '[]',
      new.status,
      new.occurred_at,
      new.occurred_at
    )
    ON CONFLICT(id) DO UPDATE SET
      parent_ref = excluded.parent_ref,
      chat_id = excluded.chat_id,
      workspace_id = excluded.workspace_id,
      title = excluded.title,
      body = excluded.body,
      metadata_text = excluded.metadata_text,
      status = excluded.status,
      updated_at = excluded.updated_at;
  END`,
    `CREATE TRIGGER chat_messages_search_au AFTER UPDATE ON chat_messages BEGIN
    INSERT INTO search_document(
      id, ref, kind, source_kind, parent_ref, chat_id, workspace_id, title, body, metadata_text,
      labels_json, status, created_at, updated_at
    ) VALUES (
      'message:' || new.id,
      new.id,
      'message',
      'message',
      new.chat_id,
      new.chat_id,
      (SELECT workspace_id FROM chats WHERE id = new.chat_id),
      COALESCE(json_extract(new.request_json, '$.toolName'), new.role),
      new.body,
      new.role || ' ' || COALESCE(new.model, '') || ' ' || COALESCE(new.request_json, ''),
      '[]',
      new.status,
      new.occurred_at,
      new.occurred_at
    )
    ON CONFLICT(id) DO UPDATE SET
      parent_ref = excluded.parent_ref,
      chat_id = excluded.chat_id,
      workspace_id = excluded.workspace_id,
      title = excluded.title,
      body = excluded.body,
      metadata_text = excluded.metadata_text,
      status = excluded.status,
      updated_at = excluded.updated_at;
  END`,
    `INSERT INTO search_document_fts(search_document_fts) VALUES ('rebuild')`,
  ),
}
