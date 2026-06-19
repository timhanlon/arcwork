import * as fs from "node:fs"
import * as path from "node:path"
import Sqlite from "better-sqlite3"
import * as Cache from "effect/Cache"
import * as Clock from "effect/Clock"
import * as Context from "effect/Context"
import * as Duration from "effect/Duration"
import * as Effect from "effect/Effect"
import * as Fiber from "effect/Fiber"
import { identity } from "effect/Function"
import * as Layer from "effect/Layer"
import * as Scope from "effect/Scope"
import * as Semaphore from "effect/Semaphore"
import * as Str from "effect/String"
import * as Stream from "effect/Stream"
import * as Reactivity from "effect/unstable/reactivity/Reactivity"
import * as Client from "effect/unstable/sql/SqlClient"
import type { Connection } from "effect/unstable/sql/SqlConnection"
import { classifySqliteError, SqlError } from "effect/unstable/sql/SqlError"
import * as Statement from "effect/unstable/sql/Statement"
import { SqlOperation } from "./sql-operation.js"
import { describeSql, type SqlShape } from "./sql-fingerprint.js"

/**
 * Build the `SqlClient` layer for an arc SQLite store, **instrumented for
 * permit-contention observability**.
 *
 * ## Why this re-implements the driver
 *
 * `@effect/sql-sqlite-node` serializes every statement through one
 * `better-sqlite3` handle guarded by a single semaphore permit. A statement's
 * `sql.execute` span therefore folds *two* costs into one number: the time
 * spent waiting for the permit, and the time SQLite actually ran. For the
 * launch-latency root cause (`work_01kv4wr6...`) that conflation is the whole
 * problem — a 1.3s `arc.target.persist` was ~1.31s of waiting behind the ingest
 * reprojection transaction and ~6ms of execution, but the span only showed
 * 1.3s.
 *
 * To split those apart we must own the acquirer, which is internal to upstream
 * `SqliteClient.make`. So this module reconstructs the same driver (one handle,
 * prepared-statement cache, single permit, WAL) via the public `SqlClient.make`
 * seam, and weaves in:
 *
 * - `arc.sqlite.acquire` — permit queue wait, with `blocked_by` / `queue_depth`.
 * - `arc.sqlite.hold` — how long a transaction held the permit (the holder).
 * - `arc.sqlite.execute` — actual SQLite execution after the permit is granted.
 *
 * plus an in-memory {@link Contention} record (current holder + waiter count) so
 * a blocked statement can name who it is waiting behind, and thresholded logs so
 * contention events surface without per-statement noise.
 *
 * The driver semantics are kept identical to upstream: regular statements take
 * the permit and release it immediately (better-sqlite3 runs synchronously, so
 * the event loop already serializes execution); only transactions hold the
 * permit across their scope. That holder is the contention source this exists to
 * expose.
 */

// ── Thresholds (ms / depth) for structured contention logs ──────────────────
// Tuned to surface real contention events, not steady-state traffic.
const THRESHOLD = {
  acquireWaitMs: 50,
  queueDepth: 2,
  executeMs: 100,
  holdMs: 100,
  transactionHoldMs: 250,
} as const

const ATTR_DB_SYSTEM_NAME = "db.system.name"

const classifyError = (cause: unknown, message: string, operation: string) =>
  classifySqliteError(cause, { message, operation })

/** Transaction-control statements are not counted as data work in the holder. */
const TXN_CONTROL = new Set(["BEGIN", "COMMIT", "ROLLBACK", "SAVEPOINT", "RELEASE"])

/** Tracks who holds the single SQLite permit, for cross-fiber `blocked_by`. */
interface Holder {
  readonly operation: string
  readonly isTransaction: boolean
  readonly acquiredAtMillis: number
  /** Data statements run while holding (mutated by the connection wrapper). */
  statements: number
  /**
   * The holder's first data statement, captured by the connection wrapper. Lets
   * a blocked waiter name *what SQL* is blocking it even when the holder carries
   * no logical `withSqlOperation` label — so contention is never anonymous.
   */
  firstShape: SqlShape | null
}

/** Per-connection contention state. One DB file == one permit == one of these. */
interface Contention {
  readonly label: string
  /** Fibers currently waiting for the permit (excludes the holder). */
  waiters: number
  holder: Holder | null
}

// ── Structured threshold logs ───────────────────────────────────────────────

const logAcquire = (
  c: Contention,
  operation: string,
  waitMs: number,
  queueDepth: number,
  holder: Holder | null,
  holderHeldMs: number,
) =>
  waitMs <= THRESHOLD.acquireWaitMs && queueDepth <= THRESHOLD.queueDepth
    ? Effect.void
    : Effect.logWarning("arc.sqlite permit contention").pipe(
        Effect.annotateLogs({
          db: c.label,
          operation,
          waitMs,
          queueDepth,
          blockedBy: holder?.operation,
          blockedBySql: holder?.firstShape?.fingerprint,
          holderHeldMs: holder ? holderHeldMs : undefined,
          holderIsTransaction: holder?.isTransaction,
        }),
      )

const logExecute = (c: Contention, operation: string, table: string | undefined, executeMs: number, rowCount: number | undefined, fingerprint: string) =>
  executeMs <= THRESHOLD.executeMs
    ? Effect.void
    : Effect.logWarning("arc.sqlite slow execute").pipe(
        Effect.annotateLogs({ db: c.label, operation, table, executeMs, rowCount, fingerprint }),
      )

const logHold = (c: Contention, operation: string, holdMs: number, statements: number) =>
  holdMs > THRESHOLD.transactionHoldMs
    ? Effect.logWarning("arc.sqlite long transaction").pipe(
        Effect.annotateLogs({ db: c.label, operation, holdMs, statements }),
      )
    : holdMs > THRESHOLD.holdMs
      ? Effect.logInfo("arc.sqlite permit hold").pipe(
          Effect.annotateLogs({ db: c.label, operation, holdMs, statements }),
        )
      : Effect.void

// ── Connection wrapper: arc.sqlite.execute spans ────────────────────────────

/**
 * Wrap a driver `Connection` so each method emits an `arc.sqlite.execute` span
 * measuring *actual* SQLite execution (the permit is already held by the time
 * these run, inside the parent `sql.execute`). Records the DB label, operation,
 * primary table, value-free fingerprint, and returned-row count; counts data
 * statements against the active holder.
 */
const instrumentConnection = (base: Connection, c: Contention): Connection => {
  const runExecute = <A>(method: string, sql: string, effect: Effect.Effect<A, SqlError>) =>
    Effect.useSpan("arc.sqlite.execute", { kind: "client" }, (span) =>
      Effect.gen(function* () {
        const shape = describeSql(sql)
        span.attribute("arc.sqlite.db", c.label)
        span.attribute("arc.sqlite.method", method)
        span.attribute("db.operation.name", shape.operation)
        if (shape.table) span.attribute("db.collection.name", shape.table)
        span.attribute("arc.sqlite.fingerprint", shape.fingerprint)

        const start = yield* Clock.currentTimeMillis
        const result = yield* effect
        const elapsed = (yield* Clock.currentTimeMillis) - start

        if (c.holder && !TXN_CONTROL.has(shape.operation)) {
          c.holder.statements += 1
          if (c.holder.firstShape === null) c.holder.firstShape = shape
        }
        const rowCount = Array.isArray(result) ? result.length : undefined
        if (rowCount !== undefined) span.attribute("db.response.returned_rows", rowCount)
        span.attribute("arc.sqlite.execute_ms", elapsed)

        yield* logExecute(c, shape.operation, shape.table, elapsed, rowCount, shape.fingerprint)
        return result
      }),
    )

  return identity<Connection>({
    execute: (sql, params, transformRows) =>
      runExecute("execute", sql, base.execute(sql, params, transformRows)),
    executeRaw: (sql, params) => runExecute("executeRaw", sql, base.executeRaw(sql, params)),
    executeValues: (sql, params) => runExecute("executeValues", sql, base.executeValues(sql, params)),
    executeUnprepared: (sql, params, transformRows) =>
      runExecute("executeUnprepared", sql, base.executeUnprepared(sql, params, transformRows)),
    executeStream: (sql, params, transformRows) => base.executeStream(sql, params, transformRows),
  })
}

// ── Permit acquirers: arc.sqlite.acquire + arc.sqlite.hold ──────────────────

/**
 * Regular (non-transaction) acquirer. Mirrors upstream: take the permit, then
 * release it immediately — better-sqlite3 executes synchronously, so the permit
 * is only a queue, not a lock held across execution. The `arc.sqlite.acquire`
 * span clocks the wait and names the holder it queued behind, if any.
 */
const makeRegularAcquirer = (semaphore: Semaphore.Semaphore, connection: Connection, c: Contention) =>
  Effect.useSpan("arc.sqlite.acquire", { kind: "client" }, (span) =>
    Effect.gen(function* () {
      const op = yield* SqlOperation
      const holder = c.holder
      c.waiters += 1
      const queueDepth = c.waiters
      span.attribute("arc.sqlite.db", c.label)
      span.attribute("arc.sqlite.operation", op.name)
      span.attribute("arc.sqlite.transaction", false)
      span.attribute("arc.sqlite.queue_depth", queueDepth)
      if (holder) {
        span.attribute("arc.sqlite.blocked_by", holder.operation)
        span.attribute("arc.sqlite.holder_is_transaction", holder.isTransaction)
      }

      const start = yield* Clock.currentTimeMillis
      // take + release around an instant read: measures queue wait only.
      const acquiredAt = yield* semaphore
        .withPermits(1)(Clock.currentTimeMillis)
        .pipe(Effect.ensuring(Effect.sync(() => void (c.waiters -= 1))))
      const waited = acquiredAt - start
      const holderHeldMs = holder ? acquiredAt - holder.acquiredAtMillis : 0
      span.attribute("arc.sqlite.wait_ms", waited)
      if (holder) {
        span.attribute("arc.sqlite.holder_held_ms", holderHeldMs)
        // Read firstShape after the wait: the holder has run statements by now,
        // so an unnamed holder is still identified by the SQL it is executing.
        if (holder.firstShape) span.attribute("arc.sqlite.blocked_by_sql", holder.firstShape.fingerprint)
      }

      yield* logAcquire(c, op.name, waited, queueDepth, holder, holderHeldMs)
      return connection
    }),
  )

/**
 * Transaction acquirer. Takes the permit and holds it across the transaction
 * scope (released by a scope finalizer), recording itself as {@link Contention}'s
 * holder so concurrent statements can name it. Opens an `arc.sqlite.hold` span
 * that closes when the permit is released, carrying hold duration + statement
 * count. Mirrors upstream's uninterruptible take + finalizer-release structure.
 */
const makeTransactionAcquirer = (semaphore: Semaphore.Semaphore, connection: Connection, c: Contention) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.useSpan("arc.sqlite.acquire", { kind: "client" }, (span) =>
      Effect.gen(function* () {
        const fiber = Fiber.getCurrent()!
        const scope = Context.getUnsafe(fiber.context, Scope.Scope)
        const op = yield* SqlOperation
        const holderAtStart = c.holder
        c.waiters += 1
        const queueDepth = c.waiters
        span.attribute("arc.sqlite.db", c.label)
        span.attribute("arc.sqlite.operation", op.name)
        span.attribute("arc.sqlite.transaction", true)
        span.attribute("arc.sqlite.queue_depth", queueDepth)
        if (holderAtStart) span.attribute("arc.sqlite.blocked_by", holderAtStart.operation)

        const start = yield* Clock.currentTimeMillis
        yield* restore(semaphore.take(1)).pipe(
          Effect.ensuring(Effect.sync(() => void (c.waiters -= 1))),
        )
        const acquiredAt = yield* Clock.currentTimeMillis
        const waited = acquiredAt - start
        span.attribute("arc.sqlite.wait_ms", waited)
        if (holderAtStart?.firstShape) {
          span.attribute("arc.sqlite.blocked_by_sql", holderAtStart.firstShape.fingerprint)
        }

        const holder: Holder = {
          operation: op.name,
          isTransaction: true,
          acquiredAtMillis: acquiredAt,
          statements: 0,
          firstShape: null,
        }
        c.holder = holder

        // Hold span: opens here, closes when the transaction scope finalizes
        // (i.e. when the permit is released). Detached from the span stack, it
        // stands alone as the holder timeline.
        const holdSpan = yield* Effect.makeSpanScoped("arc.sqlite.hold", { kind: "client" })
        holdSpan.attribute("arc.sqlite.db", c.label)
        holdSpan.attribute("arc.sqlite.operation", op.name)
        holdSpan.attribute("arc.sqlite.transaction", true)

        yield* Scope.addFinalizer(
          scope,
          Effect.gen(function* () {
            const held = (yield* Clock.currentTimeMillis) - acquiredAt
            const statements = holder.statements
            c.holder = null
            holdSpan.attribute("arc.sqlite.hold_ms", held)
            holdSpan.attribute("arc.sqlite.statements", statements)
            // Identify the holder by its first statement even when unlabeled.
            if (holder.firstShape) {
              holdSpan.attribute("arc.sqlite.fingerprint", holder.firstShape.fingerprint)
              holdSpan.attribute("db.operation.name", holder.firstShape.operation)
              if (holder.firstShape.table) holdSpan.attribute("db.collection.name", holder.firstShape.table)
            }
            yield* semaphore.release(1)
            yield* logHold(c, op.name, held, statements)
          }),
        )

        yield* logAcquire(
          c,
          op.name,
          waited,
          queueDepth,
          holderAtStart,
          holderAtStart ? acquiredAt - holderAtStart.acquiredAtMillis : 0,
        )
        return connection
      }),
    ),
  )

// ── Client construction (adapted from @effect/sql-sqlite-node) ──────────────

interface SqliteOptions {
  readonly filename: string
  readonly transformQueryNames?: ((str: string) => string) | undefined
  readonly transformResultNames?: ((str: string) => string) | undefined
}

const makeClient = (options: SqliteOptions) =>
  Effect.gen(function* () {
    const label = path.basename(options.filename)
    const contention: Contention = { label, waiters: 0, holder: null }

    const compiler = Statement.makeCompilerSqlite(options.transformQueryNames)
    const transformRows = options.transformResultNames
      ? Statement.defaultTransforms(options.transformResultNames).array
      : undefined

    const scope = yield* Effect.scope
    const db = new Sqlite(options.filename, { readonly: false })
    yield* Scope.addFinalizer(scope, Effect.sync(() => db.close()))
    db.pragma("journal_mode = WAL")

    const prepareCache = yield* Cache.make({
      capacity: 200,
      timeToLive: Duration.minutes(10),
      lookup: (sql: string) =>
        Effect.try({
          try: () => db.prepare(sql),
          catch: (cause) =>
            new SqlError({ reason: classifyError(cause, "Failed to prepare statement", "prepare") }),
        }),
    })

    const runStatement = (statement: Sqlite.Statement, params: ReadonlyArray<unknown>, raw: boolean) =>
      Effect.withFiber<ReadonlyArray<any>, SqlError>((fiber) => {
        if (Context.get(fiber.context, Client.SafeIntegers)) statement.safeIntegers(true)
        try {
          if (statement.reader) return Effect.succeed(statement.all(...params))
          const result = statement.run(...params)
          return Effect.succeed(raw ? (result as unknown as ReadonlyArray<any>) : [])
        } catch (cause) {
          return Effect.fail(
            new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }),
          )
        }
      })

    const run = (sql: string, params: ReadonlyArray<unknown>, raw = false) =>
      Effect.flatMap(Cache.get(prepareCache, sql), (s) => runStatement(s, params, raw))

    const runValues = (sql: string, params: ReadonlyArray<unknown>) =>
      Effect.acquireUseRelease(
        Cache.get(prepareCache, sql),
        (statement) =>
          Effect.try({
            try: () => {
              if (statement.reader) {
                statement.raw(true)
                return statement.all(...params) as ReadonlyArray<ReadonlyArray<unknown>>
              }
              statement.run(...params)
              return []
            },
            catch: (cause) =>
              new SqlError({ reason: classifyError(cause, "Failed to execute statement", "execute") }),
          }),
        (statement) => Effect.sync(() => statement.reader && statement.raw(false)),
      )

    const baseConnection = identity<Connection>({
      execute: (sql, params, transform) =>
        transform ? Effect.map(run(sql, params), transform) : run(sql, params),
      executeRaw: (sql, params) => run(sql, params, true),
      executeValues: (sql, params) => runValues(sql, params),
      executeUnprepared: (sql, params, transform) => {
        const effect = runStatement(db.prepare(sql), params ?? [], false)
        return transform ? Effect.map(effect, transform) : effect
      },
      executeStream: () => Stream.die("executeStream not implemented"),
    })

    const connection = instrumentConnection(baseConnection, contention)
    const semaphore = yield* Semaphore.make(1)

    return yield* Client.make({
      acquirer: makeRegularAcquirer(semaphore, connection, contention),
      transactionAcquirer: makeTransactionAcquirer(semaphore, connection, contention),
      compiler,
      spanAttributes: [[ATTR_DB_SYSTEM_NAME, "sqlite"]],
      transformRows,
    })
  })

/**
 * The arc domain store's instrumented SQLite layer. Drop-in for upstream
 * `SqliteClient.layer`: same camel<->snake transforms (so `sql.insert({
 * nativeSessionId })` targets `native_session_id` and rows come back camelCased)
 * and same WAL handle, plus the contention spans above. better-sqlite3 will not
 * create the parent directory, so we ensure it here — the path lives under the
 * profile's home-rooted `~/.arcwork/<profile>/state` dir (see paths.ts).
 */
export const sqliteLayer = (filename: string): Layer.Layer<Client.SqlClient> => {
  fs.mkdirSync(path.dirname(filename), { recursive: true })
  return Layer.effectContext(
    Effect.map(
      makeClient({
        filename,
        transformQueryNames: Str.camelToSnake,
        transformResultNames: Str.snakeToCamel,
      }),
      (client) => Context.make(Client.SqlClient, client),
    ),
  ).pipe(Layer.provide(Reactivity.layer))
}
