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
 * the change as a new migration instead. A boot-time check compares the ledger
 * against the record and dies on any mismatch (renamed id, deleted-but-applied
 * migration, refilled id gap), so divergence fails loud rather than silently
 * skipping work.
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
 * Refuse to run against a ledger that disagrees with the migrations record.
 *
 * The Migrator selects pending work purely by `id > latest applied` — it
 * records names but never re-reads them. So an edited/renumbered shipped
 * migration, a deleted migration the DB already ran, or a later refill of a
 * gap in the id sequence would all be *silently skipped* and the schema would
 * diverge from a fresh install with no signal. This check turns each of those
 * into a loud boot defect: every applied ledger row must appear in the record
 * with the same name, and every record id at or below the ledger's high-water
 * mark must already be applied.
 *
 * A DB that legitimately ran since-deleted development migrations must be
 * healed out-of-band (delete its ledger rows, drop the affected tables) —
 * that history belongs to the machine, not to the shipped record.
 */
const verifyLedger = (
  table: string,
  migrations: Migrations,
): Effect.Effect<void, SqlError, SqlClient> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const ledgerTable = yield* sql<{ name: string }>`SELECT name FROM sqlite_master WHERE type = 'table' AND name = ${table}`
    if (ledgerTable.length === 0) return

    // `id`/`name` are stable under the client's snake→camel result transform.
    const applied = yield* sql.unsafe<{ id: number; name: string }>(
      `SELECT migration_id AS id, name FROM ${table}`,
    )
    if (applied.length === 0) return

    const record = new Map<number, string>()
    for (const key of Object.keys(migrations)) {
      const match = key.match(/^(\d+)_(.+)$/)
      if (match) record.set(Number(match[1]), match[2]!)
    }

    const fault = (message: string) =>
      Effect.die(
        new Migrator.MigrationError({
          kind: "BadState",
          message: `${table}: ${message}. The ledger and the migrations record have diverged; heal the database out-of-band instead of editing shipped migrations (see migrator.ts).`,
        }),
      )

    let latestApplied = 0
    for (const row of applied) {
      latestApplied = Math.max(latestApplied, row.id)
      const name = record.get(row.id)
      if (name === undefined) {
        return yield* fault(
          `ledger has applied migration ${row.id}_${row.name}, which the migrations record no longer contains`,
        )
      }
      if (name !== row.name) {
        return yield* fault(
          `ledger has applied migration ${row.id} as "${row.name}" but the migrations record names it "${name}"`,
        )
      }
    }

    const appliedIds = new Set(applied.map((row) => row.id))
    for (const [id, name] of record) {
      if (id <= latestApplied && !appliedIds.has(id)) {
        return yield* fault(
          `migration ${id}_${name} is below the ledger high-water mark (${latestApplied}) but was never applied — it would be silently skipped`,
        )
      }
    }
  })

/**
 * Run a store's pending migrations against the ambient `SqlClient`, recording
 * each in its own ledger `table`. The ledger is first checked against the
 * record (see {@link verifyLedger}) so divergence fails loud instead of
 * skipping work. A failed/duplicate migration is an unrecoverable boot fault,
 * so a {@link Migrator.MigrationError} becomes a defect; ordinary `SqlError`s
 * propagate so the store layer surfaces them.
 */
export const runMigrations = (
  table: string,
  migrations: Migrations,
): Effect.Effect<void, SqlError, SqlClient> =>
  verifyLedger(table, migrations).pipe(
    Effect.andThen(
      Migrator.make({})({
        loader: Migrator.fromRecord(migrations),
        table,
      }),
    ),
    Effect.catchTag("MigrationError", (error) => Effect.die(error)),
    Effect.asVoid,
  )
