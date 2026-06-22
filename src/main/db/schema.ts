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
import { newArcId } from "../../shared/ids.js"
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

/** One row per workspace (a filesystem root for chats and target cwd).
 * The git columns are a cached snapshot of the workspace's cwd for fast UI —
 * `repositoryId`/`worktreeId` bind it into the git domain (sidebar grouping,
 * branch→PR map), `gitBranch`/`gitHeadSha` are refreshed by the post-checkout
 * hook. All null until git detection runs; the canonical worktree model lives
 * in `worktrees`, not here. */
export interface WorkspaceRow {
  readonly id: WorkspaceId
  readonly path: string
  readonly name: string
  readonly createdAt: string
  readonly lastOpenedAt: string
  readonly repositoryId: string | null
  readonly worktreeId: string | null
  readonly gitBranch: string | null
  readonly gitHeadSha: string | null
}

/** A local clone of a repository — one common git dir on disk. Owns the git
 * identity (remotes, main worktree) and, when resolved, the GitHub identity.
 * GitHub columns are null for a clone with no recognized remote; it is still a
 * valid repository row. Keyed locally by `commonGitDir`. */
export interface RepositoryRow {
  readonly id: string
  readonly commonGitDir: string
  /** the main worktree path (`git rev-parse --show-toplevel` of the clone) */
  readonly rootPath: string
  readonly defaultBranch: string | null
  /** JSON array of `{ name, url }` for the clone's git remotes */
  readonly remotesJson: string
  readonly githubOwner: string | null
  readonly githubRepo: string | null
  readonly githubNodeId: string | null
  readonly createdAt: string
  readonly lastSeenAt: string
}

/** A concrete git worktree under a repository's common git dir — first-class so
 * the lifecycle (list/create/open/remove/prune) has somewhere to live, distinct
 * from an arc workspace (a worktree can exist before arc opens it, or after the
 * workspace is gone). Keyed by `path`. */
export interface WorktreeRow {
  readonly id: string
  readonly repositoryId: string
  readonly path: string
  readonly branch: string | null
  readonly headSha: string | null
  readonly isDetached: number
  readonly isBare: number
  readonly isLocked: number
  readonly lockedReason: string | null
  readonly isPrunable: number
  readonly prunableReason: string | null
  readonly createdAt: string
  readonly lastSeenAt: string
}

/** The GitHub PR read model — a synced mirror of remote state, never authored
 * locally. Carries its own id so a work item can cite it via a graph edge.
 * Keyed `(repositoryId, number)`; `(repositoryId, headRef)` is the branch→PR
 * map. `checksState` is a JSON summary; `lastSyncedAt` stamps the last sync. */
export interface PullRequestRow {
  readonly id: string
  readonly repositoryId: string
  readonly number: number
  readonly githubNodeId: string | null
  readonly title: string
  readonly body: string
  readonly state: string
  readonly isDraft: number
  readonly author: string | null
  readonly headRef: string
  readonly headSha: string | null
  /** The PR head's repository identity (GitHub owner/name). Needed because
   * `headRef` is just a branch name and a fork can reuse it — see the
   * branch→PR mapping in store.ts. Null for rows synced before this column. */
  readonly headRepositoryOwner: string | null
  readonly headRepositoryName: string | null
  readonly baseRef: string
  readonly reviewState: string | null
  readonly checksState: string | null
  readonly mergeable: string | null
  readonly mergeStateStatus: string | null
  readonly url: string | null
  readonly lastSyncedAt: string
  readonly createdAt: string
  readonly updatedAt: string
}

/** One row per chat (a conversation thread). */
export interface ChatRow {
  readonly id: ChatId
  readonly workspaceId: WorkspaceId
  readonly title: string
  readonly createdAt: string
}

/** A communication endpoint — the "where turns flow" half of a worker: the
 * harness/provider, the (eventually selectable) model, and a preset. `kind` is
 * `'local'` today; the remote tier adds `'remote'`/`'cloudflare-sandbox'`
 * without a model change. Distinct from the diff endpoint (`workspaces`), which
 * is the "where code state lives" half; a `target_sessions` row binds the two.
 * `id` is a TypeID (`channel_…`) like every other arc id; identity/dedup is the
 * `(kind, provider, model, preset)` tuple, enforced by a unique index (model
 * null = "harness default"). */
export interface ChannelRow {
  readonly id: string
  readonly kind: string
  readonly provider: string
  readonly model: string | null
  readonly preset: string | null
  readonly createdAt: string
  readonly lastUsedAt: string
}

/** One row per interactive PTY target session, keyed `(chatId, provider)` — the
 * worker, i.e. the bound pair of a comm endpoint (`channelId` → `channels`) and
 * a diff endpoint (`workspaceId` → `workspaces`). `provider`/`preset`/`cwd` are
 * the pre-split inlined values, kept dual-written until the launch path reads
 * the refs; `channelId`/`workspaceId` are null only for backfill orphans. */
export interface TargetSessionRow {
  readonly id: TargetId
  readonly chatId: ChatId
  readonly provider: string
  readonly preset: string | null
  readonly cwd: string
  /** comm endpoint: the `channels` row this worker talks through */
  readonly channelId: string | null
  /** diff endpoint: the `workspaces` row this worker writes into */
  readonly workspaceId: string | null
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
  // Git/GitHub domain read model (work_01kve8w6: PRs + worktrees first-class).
  // Three flat read-model tables in the domain store — repo/worktree state is a
  // cache of local git, PRs a cache of GitHub; neither is authored content, so
  // none of it belongs in the work-graph substrate. A work→PR link is a
  // `graph_edge` to the pr id (to_kind='external'), needing no work-schema
  // change. `repositories` collapses GitHub identity and local clone into one
  // row (github_* null until a remote is resolved); the speculative repo↔clone
  // 1:N split is deferred until a real multi-clone-of-one-repo need appears.
  // `workspaces` gains nullable git columns (a cached cwd snapshot for fast UI),
  // added with default NULL so the REFERENCES clause is legal under an
  // ALTER (and so existing rows stay valid). search_document projection deferred.
  "0006_git_repositories": sqlMigration(
    `CREATE TABLE IF NOT EXISTS repositories (
    id TEXT PRIMARY KEY,
    common_git_dir TEXT NOT NULL UNIQUE,
    root_path TEXT NOT NULL,
    default_branch TEXT,
    remotes_json TEXT NOT NULL DEFAULT '[]',
    github_owner TEXT,
    github_repo TEXT,
    github_node_id TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS worktrees (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    path TEXT NOT NULL UNIQUE,
    branch TEXT,
    head_sha TEXT,
    is_detached INTEGER NOT NULL DEFAULT 0,
    is_bare INTEGER NOT NULL DEFAULT 0,
    is_locked INTEGER NOT NULL DEFAULT 0,
    locked_reason TEXT,
    is_prunable INTEGER NOT NULL DEFAULT 0,
    prunable_reason TEXT,
    created_at TEXT NOT NULL,
    last_seen_at TEXT NOT NULL
  )`,
    `CREATE TABLE IF NOT EXISTS pull_requests (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    github_node_id TEXT,
    title TEXT NOT NULL,
    body TEXT NOT NULL DEFAULT '',
    state TEXT NOT NULL,
    is_draft INTEGER NOT NULL DEFAULT 0,
    author TEXT,
    head_ref TEXT NOT NULL,
    head_sha TEXT,
    base_ref TEXT NOT NULL,
    review_state TEXT,
    checks_state TEXT,
    mergeable TEXT,
    merge_state_status TEXT,
    url TEXT,
    last_synced_at TEXT NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE(repository_id, number)
  )`,
    `CREATE INDEX IF NOT EXISTS worktrees_repo ON worktrees(repository_id, path)`,
    `CREATE INDEX IF NOT EXISTS pull_requests_repo_head ON pull_requests(repository_id, head_ref)`,
    `ALTER TABLE workspaces ADD COLUMN repository_id TEXT REFERENCES repositories(id)`,
    `ALTER TABLE workspaces ADD COLUMN worktree_id TEXT REFERENCES worktrees(id)`,
    `ALTER TABLE workspaces ADD COLUMN git_branch TEXT`,
    `ALTER TABLE workspaces ADD COLUMN git_head_sha TEXT`,
    `CREATE INDEX IF NOT EXISTS workspaces_repository ON workspaces(repository_id)`,
  ),
  // Unweld the worker into its two transports (work_01kvnz9h). A target session
  // had welded the comm endpoint (harness `provider`/`preset`) and the diff
  // endpoint (`cwd`) into one row, so neither could be selected independently.
  // Split them: `channels` is the comm endpoint (the only new table); the diff
  // endpoint is the existing `workspaces`. `target_sessions` gains `channel_id`
  // + `workspace_id` refs alongside the still-inlined `provider`/`preset`/`cwd`,
  // which stay dual-written alongside. Backfill: one local channel per distinct
  // `(provider, preset)` in use (model null = "harness default"), and each
  // session points at the workspace whose path equals its cwd. A cwd with no
  // matching workspace row leaves `workspace_id` null and falls back to the
  // `cwd` column.
  //
  // Channel ids are minted TypeIDs; identity/dedup is the `(kind, provider,
  // model, preset)` tuple, held by a unique index over `COALESCE(model,'')`/
  // `COALESCE(preset,'')` so the nullable columns still dedupe (SQLite treats
  // NULL as distinct in a plain UNIQUE).
  "0007_worker_comm_diff_endpoints": Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* sql.unsafe(`CREATE TABLE channels (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT,
      preset TEXT,
      created_at TEXT NOT NULL,
      last_used_at TEXT NOT NULL
    )`)
    yield* sql.unsafe(
      `CREATE UNIQUE INDEX channels_identity ON channels(kind, provider, COALESCE(model, ''), COALESCE(preset, ''))`,
    )
    yield* sql.unsafe(`ALTER TABLE target_sessions ADD COLUMN channel_id TEXT REFERENCES channels(id)`)
    yield* sql.unsafe(`ALTER TABLE target_sessions ADD COLUMN workspace_id TEXT REFERENCES workspaces(id)`)

    // One local channel per distinct (provider, preset) in use, each with a
    // freshly minted TypeID; timestamps span the sessions that used it.
    const groups = yield* sql.unsafe<{
      provider: string
      preset: string | null
      firstAt: string
      lastAt: string
    }>(`SELECT provider, preset, MIN(started_at) AS firstAt, MAX(started_at) AS lastAt
        FROM target_sessions GROUP BY provider, preset`)
    for (const g of groups) {
      yield* sql`INSERT INTO channels ${sql.insert({
        id: newArcId("channel"),
        kind: "local",
        provider: g.provider,
        model: null,
        preset: g.preset,
        createdAt: g.firstAt,
        lastUsedAt: g.lastAt,
      })} ON CONFLICT (kind, provider, COALESCE(model, ''), COALESCE(preset, '')) DO NOTHING`
    }

    yield* sql.unsafe(`UPDATE target_sessions
      SET channel_id = (
        SELECT id FROM channels c
        WHERE c.kind = 'local'
          AND c.provider = target_sessions.provider
          AND COALESCE(c.preset, '') = COALESCE(target_sessions.preset, '')
      )`)
    yield* sql.unsafe(`UPDATE target_sessions
      SET workspace_id = (SELECT id FROM workspaces WHERE workspaces.path = target_sessions.cwd)`)
    yield* sql.unsafe(`CREATE INDEX target_sessions_channel ON target_sessions(channel_id)`)
    yield* sql.unsafe(`CREATE INDEX target_sessions_workspace ON target_sessions(workspace_id)`)
  }),
  // Fork-safe branch→PR mapping. `head_ref` alone collides across forks — a
  // fork's `feature/foo` and a local `feature/foo` share a branch name — so a
  // local branch could resolve to someone else's fork PR. Capture the PR head's
  // repo identity (owner/name) so the branch→PR lookup can require the head to
  // live in the repository itself, not a fork. Nullable + default NULL so
  // existing rows stay valid; they backfill on the next `gh pr list` sync.
  "0008_pr_head_repository": sqlMigration(
    `ALTER TABLE pull_requests ADD COLUMN head_repository_owner TEXT`,
    `ALTER TABLE pull_requests ADD COLUMN head_repository_name TEXT`,
  ),
}
