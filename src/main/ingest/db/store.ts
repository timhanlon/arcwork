import { Clock, Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import { withSqlOperation } from "../../db/sql-operation.js"
import { arcWorkImagesDir, resolveProfile } from "../../db/paths.js"
import { imageExtForMediaType } from "../../../shared/images.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  ingestMigrations,
  type DiagnosticRow,
  type ExtractedRows,
  type FileHintRow,
  type ImageDraft,
  type MessageRow,
  type Provider,
  type StoredSession,
  type StoredSessionRow,
  type ToolCallRow,
  type UsageEventRow,
} from "./schema.js"
import { runMigrations } from "../../db/migrator.js"

const asRecords = <T>(rows: ReadonlyArray<T>): ReadonlyArray<Record<string, unknown>> =>
  rows as ReadonlyArray<Record<string, unknown>>

// `sql.insert(rows)` compiles to one bound parameter per column per row, against
// SQLite's hard `SQLITE_MAX_VARIABLE_NUMBER` ceiling (32766 on the better-sqlite3
// build). A long resumed session — files folded together by `mergeBySessionId` —
// can carry thousands of rows per table, over the ceiling for the wider tables,
// so a single-statement insert fails the whole `replaceSession`. Keep this a few
// thousand variables below the ceiling for headroom.
const MAX_SQL_VARIABLES = 30_000

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

    // Content-addressed image cache — the profile is stable for the process, so
    // resolve the dir once.
    const imagesDir = arcWorkImagesDir(resolveProfile())

    // Persist any images a tool result carried (a Read of a `.png`, a browser
    // screenshot) as `<sha256>.<ext>` under the cache dir, so the renderer can
    // render the picture from `arc-img://cache/<hash>.<ext>` instead of the old
    // `[image]` placeholder. Best-effort (never fails the ingest) and idempotent:
    // an existing content-addressed file is already correct, so it's left as-is.
    const writeImages = (images: ReadonlyArray<ImageDraft>): Effect.Effect<void> =>
      images.length === 0
        ? Effect.void
        : Effect.promise(async () => {
            try {
              await fs.mkdir(imagesDir, { recursive: true })
              for (const img of images) {
                const file = path.join(imagesDir, `${img.hash}.${imageExtForMediaType(img.mediaType)}`)
                try {
                  await fs.access(file)
                  continue
                } catch {
                  await fs.writeFile(file, Buffer.from(img.data, "base64"))
                }
              }
            } catch {
              // A failed cache write just degrades to a broken preview downstream,
              // never a failed session ingest.
            }
          }).pipe(
            Effect.withSpan("arc.ingest.write_images", {
              attributes: { "arc.ingest.images": images.length },
            }),
          )

    // Insert `rows` into `table` in chunks small enough to stay under SQLite's
    // bound-parameter ceiling (see MAX_SQL_VARIABLES). The chunk size is derived
    // from the row width, so adding a column can never silently push a table back
    // over the limit. One span per table carries the total row count, as before.
    const insertChunked = (
      table: string,
      rows: ReadonlyArray<Record<string, unknown>>,
      span: string,
    ): Effect.Effect<void, SqlError> => {
      if (rows.length === 0) return Effect.void
      const fieldsPerRow = Math.max(1, Object.keys(rows[0]!).length)
      const chunkSize = Math.max(1, Math.floor(MAX_SQL_VARIABLES / fieldsPerRow))
      return Effect.gen(function* () {
        for (let i = 0; i < rows.length; i += chunkSize) {
          const chunk = rows.slice(i, i + chunkSize)
          yield* sql`INSERT INTO ${sql(table)} ${sql.insert(chunk)}`
        }
      }).pipe(Effect.withSpan(span, { attributes: { "arc.ingest.rows": rows.length } }))
    }

    // The single long SQLite permit holder: a full-projection replace runs as
    // one transaction (upsert + 4 deletes + up to 4 bulk inserts), so a launch
    // landing mid-reprojection queues its tiny target_sessions upsert behind it.
    // `withSqlOperation` names this work on the holder record + acquire spans;
    // the phase spans below decompose the hold so duration can be correlated
    // with transcript size (row counts on the outer span).
    const replaceSession = (rows: ExtractedRows) =>
      // Write the image bytes to the cache first, so the files exist before the
      // rows that reference them land (a crash between the two leaves harmless
      // orphan cache files, not dangling references).
      Effect.andThen(
        writeImages(rows.images ?? []),
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
                sql`DELETE FROM usage_events WHERE session_id = ${s.id}`,
                sql`DELETE FROM diagnostics WHERE session_id = ${s.id}`,
                sql`DELETE FROM tool_calls WHERE session_id = ${s.id}`,
                sql`DELETE FROM messages WHERE session_id = ${s.id}`,
              ],
              { discard: true },
            ).pipe(Effect.withSpan("arc.ingest.delete_children"))

            // Insert in FK order: messages, then tool_calls, then the rows that
            // reference them. Casts: row interfaces are structurally records but
            // lack an index signature, which `sql.insert` requires.
            yield* insertChunked("messages", asRecords(rows.messages), "arc.ingest.insert_messages")
            yield* insertChunked("tool_calls", asRecords(rows.toolCalls), "arc.ingest.insert_tool_calls")
            yield* insertChunked("file_hints", asRecords(rows.fileHints), "arc.ingest.insert_file_hints")
            yield* insertChunked("usage_events", asRecords(rows.usageEvents), "arc.ingest.insert_usage_events")
            yield* insertChunked("diagnostics", asRecords(rows.diagnostics), "arc.ingest.insert_diagnostics")
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
              "arc.ingest.usage_events": rows.usageEvents.length,
              "arc.ingest.diagnostics": rows.diagnostics.length,
            },
          }),
          withSqlOperation("arc.ingest.replace_session", { sessionId: rows.session.id }),
        ),
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
        const usageEvents = yield* sql<UsageEventRow>`SELECT * FROM usage_events WHERE session_id = ${id} ORDER BY sequence`
        const diagnostics = yield* sql<DiagnosticRow>`SELECT * FROM diagnostics WHERE session_id = ${id} ORDER BY id`
        return { session, messages, toolCalls, fileHints, usageEvents, diagnostics } satisfies StoredSession
      })

    return { replaceSession, listSessions, getSession } as const
  }),
)
