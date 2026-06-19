// Test-only drop-in for `better-sqlite3`, backed by Node's built-in `node:sqlite`.
//
// The real better-sqlite3 is a native addon compiled for Electron's ABI (via
// `pnpm rebuild`), so it will not load under the plain-Node test runner — and
// rebuilding it for Node would break the app. `node:sqlite` ships inside the
// Node binary the tests already run on: no native build, no ABI mismatch, no
// emscripten/WASM asset loading. vitest aliases `better-sqlite3` to this module
// (see vitest.config.ts), so the real `@effect/sql-sqlite-node` client and the
// production `sqliteLayer` run unchanged on top of it.
//
// Only the surface `@effect/sql-sqlite-node`'s SqliteClient.make touches is
// implemented: `new Database(filename, { readonly })`, `db.pragma`,
// `db.prepare -> { reader, all, run, raw, safeIntegers }`, `db.close`.
// `node:sqlite`'s StatementSync.all() executes any statement and returns rows
// when present, so a constant `reader = true` lets one path serve reads, writes,
// DDL, and INSERT ... RETURNING alike (better-sqlite3 routes on `.reader`).
import { DatabaseSync, type StatementSync } from "node:sqlite"

class ShimStatement {
  #stmt: StatementSync
  #raw = false
  readonly reader = true

  constructor(stmt: StatementSync) {
    this.#stmt = stmt
  }

  all(...params: ReadonlyArray<unknown>): ReadonlyArray<unknown> {
    const rows = this.#stmt.all(...(params as Array<never>)) as Array<Record<string, unknown>>
    return this.#raw ? rows.map((row) => Object.values(row)) : rows
  }

  run(...params: ReadonlyArray<unknown>): unknown {
    return this.#stmt.run(...(params as Array<never>))
  }

  raw(enabled = true): this {
    this.#raw = enabled
    return this
  }

  safeIntegers(enabled = true): this {
    this.#stmt.setReadBigInts(enabled)
    return this
  }
}

export default class Database {
  #db: DatabaseSync

  constructor(filename: string, options?: { readonly?: boolean }) {
    this.#db = new DatabaseSync(filename, { readOnly: options?.readonly ?? false })
  }

  pragma(source: string): void {
    this.#db.exec(`PRAGMA ${source}`)
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatement(this.#db.prepare(sql))
  }

  close(): void {
    this.#db.close()
  }
}
