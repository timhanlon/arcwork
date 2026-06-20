/**
 * Versioned SQLite migrations for arc's durable stores.
 *
 * Every store (`ArcStore`, `WorkStore`, `IngestStore`) runs its schema through
 * Effect's built-in {@link Migrator} instead of "`CREATE … IF NOT EXISTS` plus
 * ad-hoc `ALTER` at open." The migrator keeps a ledger table
 * (one row per applied migration: `migration_id`, `name`, `created_at`), reads
 * the latest applied id, and runs only the pending migrations — in id order, in
 * a single transaction. That gives schema evolution explicit ordering, a record
 * of what ran, and a testable path for future schema changes.
 *
 * Migrations are defined **in code** as a `Record<"<id>_<name>", Effect>` (see
 * {@link Migrator.fromRecord}) rather than loaded from files by glob. The app is
 * bundled by electron-vite; an in-bundle record sidesteps dynamic `import()` of
 * migration files, and works unchanged under the vitest `node:sqlite` shim.
 *
 * ## Ledger per store, not per file
 *
 * In the app, `arc.sqlite` hosts three independent schema domains — arc's
 * domain, the work graph, and re-ingested provider history — over one shared
 * `SqlClient`. Each store owns its own migrations record and its own ledger
 * table ({@link ArcStore} → `arc_migrations`, {@link WorkStore} →
 * `work_migrations`, {@link IngestStore} → `ingest_migrations`), so their id
 * spaces never collide and `IngestStore` can still migrate a *different* file in
 * the ingest CLI path. The connection-level PRAGMAs (WAL, `busy_timeout`,
 * `foreign_keys`) stay in each store's layer and run before the migrator — they
 * are connection settings, not schema.
 *
 * ## Adding a migration
 *
 * Append a new key `"NNNN_short_name"` (next integer id, zero-padded for
 * readability — only the number matters) to the store's migrations record with
 * a {@link sqlMigration} of the forward DDL. **Never edit or renumber an
 * existing migration**: the ledger only runs ids greater than the latest
 * applied, so changing `0001` after it has shipped will not re-run it. Express
 * the change as a new migration instead.
 *
 * New migrations should be **plain forward DDL** (`CREATE TABLE foo …`, `ALTER
 * TABLE foo ADD COLUMN …`) — the ledger guarantees each runs exactly once, so
 * defensive column-existence guards are unnecessary. The baseline migrations
 * keep `IF NOT EXISTS` for idempotent development re-opens; follow-on
 * migrations should not.
 *
 * @since arcwork
 */
import { Effect } from "effect"
import * as Migrator from "effect/unstable/sql/Migrator"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"

/**
 * One migration from an ordered list of raw DDL statements. Each runs through
 * `sql.unsafe` (DDL is a literal string, never interpolated user input) in the
 * order given, inside the transaction the migrator opens around the whole run.
 */
export const sqlMigration = (
  ...statements: ReadonlyArray<string>
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    yield* Effect.forEach(statements, (ddl) => sql.unsafe(ddl), { discard: true })
  })

/** The migration record shape every store exports: keys are `"<id>_<name>"`. */
export type Migrations = Record<string, Effect.Effect<void, SqlError, SqlClient>>

/**
 * Run a store's pending migrations against the ambient `SqlClient`, recording
 * each in its own ledger `table`. A failed/duplicate migration is an
 * unrecoverable boot fault, so a {@link Migrator.MigrationError} becomes a
 * defect; ordinary `SqlError`s propagate so the store layer surfaces them.
 */
export const runMigrations = (
  table: string,
  migrations: Migrations,
): Effect.Effect<void, SqlError, SqlClient> =>
  Migrator.make({})({
    loader: Migrator.fromRecord(migrations),
    table,
  }).pipe(
    Effect.catchTag("MigrationError", (error) => Effect.die(error)),
    Effect.asVoid,
  )
