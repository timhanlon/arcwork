import { sqlMigration, type Migrations } from "../../db/migrator.js"

// Re-exported from the shared canonical definition so ingest rows and the
// renderer-facing schemas key off one Provider union.
export { ALL_PROVIDERS, Provider } from "../../../shared/provider.js"
import type { Provider } from "../../../shared/provider.js"

/**
 * The database schema and the row shapes extractors produce.
 *
 * Row types are camelCase; the SqliteClient is configured with
 * `transformQueryNames`/`transformResultNames` (camel <-> snake) so these map
 * directly onto the snake_case columns below. This file holds NO Arc domain
 * concepts — just provider history flattened into queryable rows.
 */

/** One row per native provider session. Store-managed timestamps are added on write. */
export interface SessionRow {
  readonly id: string
  readonly provider: Provider
  readonly nativeSessionId: string
  readonly workspaceRoot: string
  readonly title: string | null
  readonly createdAt: string | null
  readonly updatedAt: string | null
  readonly sourcePath: string | null
  readonly rawMetadataJson: string | null
}

/** One row per extracted user/assistant message. */
export interface MessageRow {
  readonly id: string
  readonly sessionId: string
  readonly provider: Provider
  readonly nativeMessageId: string | null
  readonly role: string
  readonly createdAt: string | null
  readonly model: string | null
  readonly text: string | null
  readonly thinking: string | null
  readonly rawJson: string | null
  /** Per-table message index, used for the row id and the UNIQUE constraint. */
  readonly sequence: number
  /**
   * Per-session display order shared with `tool_calls`. The extractor stamps
   * one monotonic counter onto every renderable row in source order, so a
   * transcript view can `ORDER BY ordinal` over `messages UNION tool_calls` and
   * recover the true interleaving (`messages.sequence` / `tool_calls.sequence`
   * are independent spaces and cannot).
   */
  readonly ordinal: number
}

/** One row per extracted tool call (with its paired result merged in). */
export interface ToolCallRow {
  readonly id: string
  readonly sessionId: string
  readonly messageId: string | null
  readonly provider: Provider
  readonly nativeToolId: string | null
  readonly name: string | null
  readonly kind: string | null
  readonly inputJson: string | null
  readonly outputText: string | null
  readonly rawJson: string | null
  /** Per-table tool index, used for the row id. */
  readonly sequence: number
  /** Per-session display order shared with `messages` — see `MessageRow.ordinal`. */
  readonly ordinal: number
}

/** Best-effort file paths mentioned by tool inputs/patches. Not attribution proof. */
export interface FileHintRow {
  readonly id: string
  readonly sessionId: string
  readonly messageId: string | null
  readonly toolCallId: string | null
  readonly provider: Provider
  readonly path: string
  readonly source: string
  readonly confidence: string
  readonly rawJson: string | null
}

/** Provider-reported token/context usage snapshots. */
export interface UsageEventRow {
  readonly id: string
  readonly sessionId: string
  readonly provider: Provider
  readonly occurredAt: string | null
  readonly nativeRequestId: string | null
  readonly model: string | null
  readonly contextUsedTokens: number | null
  readonly contextWindowTokens: number | null
  readonly inputTokens: number | null
  readonly outputTokens: number | null
  readonly rawJson: string | null
  /** Per-table usage index, used for the row id and UNIQUE constraint. */
  readonly sequence: number
}

/** Parser failures are data, not crashes: one bad line/blob never fails the session. */
export interface DiagnosticRow {
  readonly id: string
  readonly sessionId: string | null
  readonly provider: Provider
  readonly severity: string
  readonly code: string
  readonly message: string
  readonly sourcePath: string | null
  readonly rawJson: string | null
  readonly createdAt: string
}

/**
 * Strip `readonly` for rows still being assembled during extraction — e.g. a
 * tool call whose `outputText` is filled in when its later result arrives.
 * A `Mutable<Row>[]` is still assignable to the `ReadonlyArray<Row>` fields below.
 */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] }

/** What a provider's `extract` returns for one native session. */
export interface ExtractedRows {
  readonly session: SessionRow
  readonly messages: ReadonlyArray<MessageRow>
  readonly toolCalls: ReadonlyArray<ToolCallRow>
  readonly fileHints: ReadonlyArray<FileHintRow>
  readonly usageEvents: ReadonlyArray<UsageEventRow>
  readonly diagnostics: ReadonlyArray<DiagnosticRow>
}

/** A session row as stored, including the store-managed ingest timestamps. */
export interface StoredSessionRow extends SessionRow {
  readonly insertedAt: string
  readonly lastIngestedAt: string
}

/** A full session read back from the store. */
export interface StoredSession {
  readonly session: StoredSessionRow
  readonly messages: ReadonlyArray<MessageRow>
  readonly toolCalls: ReadonlyArray<ToolCallRow>
  readonly fileHints: ReadonlyArray<FileHintRow>
  readonly usageEvents: ReadonlyArray<UsageEventRow>
  readonly diagnostics: ReadonlyArray<DiagnosticRow>
}

/**
 * Versioned migrations for the ingest store, keyed `"<id>_<name>"` and run by
 * the {@link runMigrations} ledger (table `ingest_migrations`). `0001_initial`
 * is the current development baseline — tables before indexes, with `IF NOT
 * EXISTS` so re-opening a current DB is harmless. The `ordinal` columns and
 * indexes are part of the baseline. `ON DELETE CASCADE`/`SET NULL` require
 * `PRAGMA foreign_keys = ON`, which the store enables before migrating. Add
 * future changes as new `"NNNN_*"` keys of forward DDL — see migrator.ts.
 */
export const ingestMigrations: Migrations = {
  "0001_initial": sqlMigration(
    `CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    native_session_id TEXT NOT NULL,
    workspace_root TEXT NOT NULL,
    title TEXT,
    created_at TEXT,
    updated_at TEXT,
    source_path TEXT,
    raw_metadata_json TEXT,
    inserted_at TEXT NOT NULL,
    last_ingested_at TEXT NOT NULL,
    UNIQUE(provider, native_session_id)
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    native_message_id TEXT,
    role TEXT NOT NULL,
    created_at TEXT,
    model TEXT,
    text TEXT,
    thinking TEXT,
    raw_json TEXT,
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0,
    UNIQUE(session_id, sequence)
  )`,
  `CREATE TABLE IF NOT EXISTS tool_calls (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    native_tool_id TEXT,
    name TEXT,
    kind TEXT,
    input_json TEXT,
    output_text TEXT,
    raw_json TEXT,
    sequence INTEGER NOT NULL,
    ordinal INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS file_hints (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    message_id TEXT REFERENCES messages(id) ON DELETE SET NULL,
    tool_call_id TEXT REFERENCES tool_calls(id) ON DELETE SET NULL,
    provider TEXT NOT NULL,
    path TEXT NOT NULL,
    source TEXT NOT NULL,
    confidence TEXT NOT NULL,
    raw_json TEXT
  )`,
  `CREATE TABLE IF NOT EXISTS diagnostics (
    id TEXT PRIMARY KEY,
    session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    severity TEXT NOT NULL,
    code TEXT NOT NULL,
    message TEXT NOT NULL,
    source_path TEXT,
    raw_json TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS messages_session_sequence ON messages(session_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS tool_calls_session_sequence ON tool_calls(session_id, sequence)`,
  `CREATE INDEX IF NOT EXISTS file_hints_path ON file_hints(path)`,
  `CREATE INDEX IF NOT EXISTS sessions_workspace_provider ON sessions(workspace_root, provider)`,
  `CREATE INDEX IF NOT EXISTS messages_session_ordinal ON messages(session_id, ordinal)`,
  `CREATE INDEX IF NOT EXISTS tool_calls_session_ordinal ON tool_calls(session_id, ordinal)`,
  ),
  // Index the foreign-key *referencing* columns. With `PRAGMA foreign_keys = ON`,
  // a `DELETE FROM messages` must NULL every child row whose `message_id` points
  // at a deleted message (`ON DELETE SET NULL`); without an index on the child's
  // referencing column SQLite full-scans the child table *per deleted row*. Trace
  // evidence: `DELETE FROM messages` inside the reprojection transaction ran
  // 570–740ms and grew with total table size, its query plan showing
  // `SCAN file_hints` + `SCAN tool_calls`. That single statement was the permit
  // holder that head-of-line-blocked launches (see work_01kv4x8m / work_01kv4wr6).
  // These three indexes turn those scans into searches, collapsing the hold.
  "0002_fk_referencing_indexes": sqlMigration(
    `CREATE INDEX IF NOT EXISTS tool_calls_message_id ON tool_calls(message_id)`,
    `CREATE INDEX IF NOT EXISTS file_hints_message_id ON file_hints(message_id)`,
    `CREATE INDEX IF NOT EXISTS file_hints_tool_call_id ON file_hints(tool_call_id)`,
  ),
  "0003_usage_events": sqlMigration(
    `CREATE TABLE usage_events (
    id TEXT PRIMARY KEY,
    session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
    provider TEXT NOT NULL,
    occurred_at TEXT,
    native_request_id TEXT,
    model TEXT,
    context_used_tokens INTEGER,
    context_window_tokens INTEGER,
    input_tokens INTEGER,
    output_tokens INTEGER,
    raw_json TEXT,
    sequence INTEGER NOT NULL,
    UNIQUE(session_id, sequence)
  )`,
    `CREATE INDEX usage_events_session_sequence ON usage_events(session_id, sequence)`,
  ),
}
