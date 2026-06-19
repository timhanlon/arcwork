import { Context, Effect } from "effect"

/**
 * The logical operation a SQL statement belongs to, carried as an ambient
 * fiber-scoped value so the instrumented SQLite layer (see {@link file://./sqlite.ts})
 * can attribute low-level contention to the work that caused it.
 *
 * The single SQLite connection is guarded by one permit (see `sqlite.ts`). When
 * a statement waits for that permit, the wait span needs two names: *who is
 * waiting* (this fiber's operation) and *who holds the permit* (the operation
 * recorded on the active holder). A compiled `sql.execute` only knows the SQL
 * text — not that it is "the launch-path target_sessions upsert" or "the ingest
 * full-projection replace". `withSqlOperation` supplies that human-meaningful
 * label, and the acquirer reads it via this reference.
 */
export interface SqlOperation {
  readonly name: string
  readonly attributes?: Record<string, unknown> | undefined
}

/**
 * Fiber-scoped current SQL operation. A `Context.Reference` so reads always
 * succeed: statements run with no `withSqlOperation` wrapper report the default
 * name rather than failing or carrying a missing-service requirement.
 */
export const SqlOperation = Context.Reference<SqlOperation>("arc/db/SqlOperation", {
  defaultValue: () => ({ name: "arc.sql.unattributed" }),
})

/**
 * Tag an effect's SQL with a logical operation name (and optional attributes).
 * The instrumented SQLite layer stamps the name onto `arc.sqlite.acquire` /
 * `arc.sqlite.hold` spans and onto the in-memory holder record, so a blocked
 * query records *which* operation it waited behind, not just that it waited.
 *
 * Wrap at the logical boundary — `replaceSession`, the launch-path persist —
 * not per statement; every statement inside inherits the name.
 */
export const withSqlOperation =
  (name: string, attributes?: Record<string, unknown>) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
    Effect.provideService(effect, SqlOperation, { name, attributes })
