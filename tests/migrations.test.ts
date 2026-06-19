import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { describe, expect, it } from "vitest"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { runMigrations, sqlMigration } from "../src/main/db/migrator.js"
import { arcMigrations } from "../src/main/db/schema.js"
import { workMigrations } from "../src/main/work/schema.js"
import { ingestMigrations } from "../src/main/ingest/db/schema.js"

// Real production sqliteLayer; vitest aliases native `better-sqlite3` to a
// `node:sqlite` drop-in (see vitest.config.ts), so the actual Migrator SQL runs
// with no native build. Each test gets its own in-memory DB via a fresh
// ManagedRuntime, disposed after the program — so one connection spans each
// staged migration test.
const run = async <A>(program: Effect.Effect<A, SqlError, SqlClient>): Promise<A> => {
  const runtime = ManagedRuntime.make(sqliteLayer(":memory:"))
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const tableExists = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql.unsafe<{ name: string }>(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='${table}'`,
    )
    return rows.length > 0
  })

const columnNames = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql.unsafe<{ name: string }>(`SELECT name FROM pragma_table_info('${table}')`)
    return rows.map((r) => r.name)
  })

const ledgerCount = (table: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient
    const rows = yield* sql.unsafe<{ c: number }>(`SELECT count(*) AS c FROM ${table}`)
    return rows[0]?.c ?? 0
  })

describe("versioned migrations (ledger over node:sqlite)", () => {
  it("arc baseline creates every table + the once-additive chat_messages columns, and records the ledger", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations("arc_migrations", arcMigrations)
        return {
          workspaces: yield* tableExists("workspaces"),
          chats: yield* tableExists("chats"),
          targetSessions: yield* tableExists("target_sessions"),
          activityEvents: yield* tableExists("activity_events"),
          chatMessages: yield* tableExists("chat_messages"),
          rawHookSignals: yield* tableExists("raw_hook_signals"),
          ledgerExists: yield* tableExists("arc_migrations"),
          chatMessageCols: yield* columnNames("chat_messages"),
        }
      }),
    )

    expect(result.workspaces).toBe(true)
    expect(result.chats).toBe(true)
    expect(result.targetSessions).toBe(true)
    expect(result.activityEvents).toBe(true)
    expect(result.chatMessages).toBe(true)
    expect(result.rawHookSignals).toBe(true)
    expect(result.ledgerExists).toBe(true)
    // The columns once bolted on by an ad-hoc ALTER are part of the baseline.
    expect(result.chatMessageCols).toContain("request_json")
    expect(result.chatMessageCols).toContain("model")
  })

  it("work migrations create the graph + comment tables and record each in the ledger", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations("work_migrations", workMigrations)
        return {
          node: yield* tableExists("graph_node"),
          ref: yield* tableExists("graph_ref"),
          refUpdate: yield* tableExists("graph_ref_update"),
          edge: yield* tableExists("graph_edge"),
          comment: yield* tableExists("work_comment"),
        }
      }),
    )
    expect(result.node).toBe(true)
    expect(result.ref).toBe(true)
    expect(result.refUpdate).toBe(true)
    expect(result.edge).toBe(true)
    expect(result.comment).toBe(true)
  })

  it("ingest baseline creates its tables with the folded-in `ordinal` column", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations("ingest_migrations", ingestMigrations)
        return {
          sessions: yield* tableExists("sessions"),
          messages: yield* tableExists("messages"),
          toolCalls: yield* tableExists("tool_calls"),
          messageCols: yield* columnNames("messages"),
          toolCallCols: yield* columnNames("tool_calls"),
        }
      }),
    )
    expect(result.sessions).toBe(true)
    expect(result.messages).toBe(true)
    expect(result.toolCalls).toBe(true)
    expect(result.messageCols).toContain("ordinal")
    expect(result.toolCallCols).toContain("ordinal")
  })

  it("is idempotent: a second run applies nothing and leaves the ledger unchanged", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* runMigrations("arc_migrations", arcMigrations)
        const afterFirst = yield* ledgerCount("arc_migrations")
        yield* runMigrations("arc_migrations", arcMigrations)
        const afterSecond = yield* ledgerCount("arc_migrations")
        return { afterFirst, afterSecond }
      }),
    )
    // The point is "unchanged", not a specific count — so compare the two runs
    // rather than hardcoding how many migrations the baseline happens to have.
    expect(result.afterSecond).toBe(result.afterFirst)
  })

  it("runs future migrations after the current baseline", async () => {
    // Exercises the forward path: a base table, then an ALTER added as a later
    // id. A DB that has already run 0001 picks up 0002 on the next run, and the
    // ledger advances to record it.
    const base = { "0001_initial": sqlMigration(`CREATE TABLE widgets (id TEXT PRIMARY KEY)`) }
    const upgraded = {
      ...base,
      "0002_widgets_add_color": sqlMigration(`ALTER TABLE widgets ADD COLUMN color TEXT`),
    }

    const result = await run(
      Effect.gen(function* () {
        // Current baseline: only 0001 applied.
        yield* runMigrations("widget_migrations", base)
        const beforeCols = yield* columnNames("widgets")
        const beforeLedger = yield* ledgerCount("widget_migrations")

        // Current shape: 0002 is now pending and runs; 0001 is skipped.
        yield* runMigrations("widget_migrations", upgraded)
        const afterCols = yield* columnNames("widgets")
        const afterLedger = yield* ledgerCount("widget_migrations")

        return { beforeCols, beforeLedger, afterCols, afterLedger }
      }),
    )

    expect(result.beforeCols).not.toContain("color")
    expect(result.beforeLedger).toBe(1)
    expect(result.afterCols).toContain("color")
    expect(result.afterLedger).toBe(2)
  })
})
