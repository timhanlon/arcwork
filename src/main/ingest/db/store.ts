import { Clock, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { withSqlOperation } from "../../db/sql-operation.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  ingestMigrations,
  type DiagnosticRow,
  type ExtractedRows,
  type FileHintRow,
  type MessageRow,
  type Provider,
  type StoredSession,
  type StoredSessionRow,
  type ToolCallRow,
} from "./schema.js"
import { runMigrations } from "../../db/migrator.js"

const asRecords = <T>(rows: ReadonlyArray<T>): ReadonlyArray<Record<string, unknown>> =>
  rows as ReadonlyArray<Record<string, unknown>>

export interface SessionFilter {
  readonly provider?: Provider
  readonly workspaceRoot?: string
}

/**
 * Persistence for extracted provider history. The only writer is
 * `replaceSession`, which is idempotent: re-ingesting a session replaces all of
 * its child rows in a single transaction (see the ownership plan's idempotency
 * rule).
 */
export class IngestStore extends Context.Service<
  IngestStore,
  {
    readonly replaceSession: (rows: ExtractedRows) => Effect.Effect<void, SqlError>
    readonly listSessions: (
      filter?: SessionFilter,
    ) => Effect.Effect<ReadonlyArray<StoredSessionRow>, SqlError>
    readonly getSession: (id: string) => Effect.Effect<StoredSession | undefined, SqlError>
  }
>()("arcwork/IngestStore") {}

export const IngestStoreLive = Layer.effect(
  IngestStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient

    // Enable referential actions (connection setting), then run the ledgered
    // migrations that create the tables/indexes.
    yield* sql`PRAGMA foreign_keys = ON`
    yield* runMigrations("ingest_migrations", ingestMigrations)

    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())

    // The single long SQLite permit holder: a full-projection replace runs as
    // one transaction (upsert + 4 deletes + up to 4 bulk inserts), so a launch
    // landing mid-reprojection queues its tiny target_sessions upsert behind it.
    // `withSqlOperation` names this work on the holder record + acquire spans;
    // the phase spans below decompose the hold so duration can be correlated
    // with transcript size (row counts on the outer span).
    const replaceSession = (rows: ExtractedRows) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const now = yield* nowIso
            const s = rows.session

            // Upsert the session, preserving the original inserted_at on conflict.
            yield* sql`INSERT INTO sessions ${sql.insert({
              id: s.id,
              provider: s.provider,
              nativeSessionId: s.nativeSessionId,
              workspaceRoot: s.workspaceRoot,
              title: s.title,
              createdAt: s.createdAt,
              updatedAt: s.updatedAt,
              sourcePath: s.sourcePath,
              rawMetadataJson: s.rawMetadataJson,
              insertedAt: now,
              lastIngestedAt: now,
            })} ON CONFLICT(id) DO UPDATE SET
              workspace_root = excluded.workspace_root,
              title = excluded.title,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              source_path = excluded.source_path,
              raw_metadata_json = excluded.raw_metadata_json,
              last_ingested_at = excluded.last_ingested_at`.pipe(
              Effect.withSpan("arc.ingest.upsert_session"),
            )

            // Replace child rows. Delete leaves first to satisfy foreign keys.
            yield* Effect.all(
              [
                sql`DELETE FROM file_hints WHERE session_id = ${s.id}`,
                sql`DELETE FROM diagnostics WHERE session_id = ${s.id}`,
                sql`DELETE FROM tool_calls WHERE session_id = ${s.id}`,
                sql`DELETE FROM messages WHERE session_id = ${s.id}`,
              ],
              { discard: true },
            ).pipe(Effect.withSpan("arc.ingest.delete_children"))

            // Insert in FK order: messages, then tool_calls, then file_hints.
            // Casts: row interfaces are structurally records but lack an index
            // signature, which `sql.insert` requires.
            if (rows.messages.length > 0) {
              yield* sql`INSERT INTO messages ${sql.insert(asRecords(rows.messages))}`.pipe(
                Effect.withSpan("arc.ingest.insert_messages", {
                  attributes: { "arc.ingest.rows": rows.messages.length },
                }),
              )
            }
            if (rows.toolCalls.length > 0) {
              yield* sql`INSERT INTO tool_calls ${sql.insert(asRecords(rows.toolCalls))}`.pipe(
                Effect.withSpan("arc.ingest.insert_tool_calls", {
                  attributes: { "arc.ingest.rows": rows.toolCalls.length },
                }),
              )
            }
            if (rows.fileHints.length > 0) {
              yield* sql`INSERT INTO file_hints ${sql.insert(asRecords(rows.fileHints))}`.pipe(
                Effect.withSpan("arc.ingest.insert_file_hints", {
                  attributes: { "arc.ingest.rows": rows.fileHints.length },
                }),
              )
            }
            if (rows.diagnostics.length > 0) {
              yield* sql`INSERT INTO diagnostics ${sql.insert(asRecords(rows.diagnostics))}`.pipe(
                Effect.withSpan("arc.ingest.insert_diagnostics", {
                  attributes: { "arc.ingest.rows": rows.diagnostics.length },
                }),
              )
            }
          }),
        )
        .pipe(
          Effect.withSpan("arc.ingest.replace_session", {
            attributes: {
              "arc.ingest.session_id": rows.session.id,
              "arc.ingest.provider": rows.session.provider,
              "arc.ingest.messages": rows.messages.length,
              "arc.ingest.tool_calls": rows.toolCalls.length,
              "arc.ingest.file_hints": rows.fileHints.length,
              "arc.ingest.diagnostics": rows.diagnostics.length,
            },
          }),
          withSqlOperation("arc.ingest.replace_session", { sessionId: rows.session.id }),
        )

    const listSessions = (filter?: SessionFilter) =>
      Effect.gen(function* () {
        const conditions = []
        if (filter?.provider) conditions.push(sql`provider = ${filter.provider}`)
        if (filter?.workspaceRoot) conditions.push(sql`workspace_root = ${filter.workspaceRoot}`)
        const where = conditions.length > 0 ? sql` WHERE ${sql.and(conditions)}` : sql``
        return yield* sql<StoredSessionRow>`SELECT * FROM sessions${where} ORDER BY created_at DESC, id`
      })

    const getSession = (id: string) =>
      Effect.gen(function* () {
        const sessions = yield* sql<StoredSessionRow>`SELECT * FROM sessions WHERE id = ${id}`
        const session = sessions[0]
        if (!session) return undefined
        const messages = yield* sql<MessageRow>`SELECT * FROM messages WHERE session_id = ${id} ORDER BY sequence`
        const toolCalls = yield* sql<ToolCallRow>`SELECT * FROM tool_calls WHERE session_id = ${id} ORDER BY sequence`
        const fileHints = yield* sql<FileHintRow>`SELECT * FROM file_hints WHERE session_id = ${id} ORDER BY id`
        const diagnostics = yield* sql<DiagnosticRow>`SELECT * FROM diagnostics WHERE session_id = ${id} ORDER BY id`
        return { session, messages, toolCalls, fileHints, diagnostics } satisfies StoredSession
      })

    return { replaceSession, listSessions, getSession } as const
  }),
)
