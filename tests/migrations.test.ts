import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { describe, expect, it } from "vitest"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { runMigrations, sqlMigration, type Migrations } from "../src/main/db/migrator.js"
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

/**
 * Whitespace-normalized dump of every user table/index/trigger/view. Two DBs
 * with equal dumps have the same schema, whatever migration path built them.
 */
const schemaDump = Effect.gen(function* () {
  const sql = yield* SqlClient
  const rows = yield* sql.unsafe<{ type: string; name: string; sql: string | null }>(
    `SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name`,
  )
  return rows.map((r) => `${r.type} ${r.name}: ${(r.sql ?? "").replace(/\s+/g, " ").trim()}`)
})

const stores = [
  ["arc_migrations", arcMigrations],
  ["work_migrations", workMigrations],
  ["ingest_migrations", ingestMigrations],
] as const

/** The record restricted to its first `length` keys, in id order. */
const prefixOf = (migrations: Migrations, length: number): Migrations =>
  Object.fromEntries(
    Object.entries(migrations)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .slice(0, length),
  )

describe("versioned migrations (ledger over node:sqlite)", () => {
  it("pins the fresh end-state schema of every store", async () => {
    for (const [table, migrations] of stores) {
      const dump = await run(
        Effect.gen(function* () {
          yield* runMigrations(table, migrations)
          return yield* schemaDump
        }),
      )
      expect(dump).toMatchSnapshot(table)
    }
  })

  it("migrates every historical ledger prefix to the same schema as a fresh run", async () => {
    // The property that keeps upgrades honest: a DB that stopped after ANY
    // shipped migration, later migrated to head, has byte-identical schema to a
    // fresh install. Catches edited baselines, order-dependent DDL, and repair
    // migrations that leave stragglers behind.
    for (const [table, migrations] of stores) {
      const fresh = await run(
        Effect.gen(function* () {
          yield* runMigrations(table, migrations)
          return yield* schemaDump
        }),
      )
      const total = Object.keys(migrations).length
      for (let applied = 1; applied < total; applied++) {
        const staged = await run(
          Effect.gen(function* () {
            yield* runMigrations(table, prefixOf(migrations, applied))
            yield* runMigrations(table, migrations)
            return yield* schemaDump
          }),
        )
        expect(staged, `${table}: resume after ${applied}/${total}`).toEqual(fresh)
      }
    }
  })

  it("target sessions are keyed by TypeID, not by chat/provider", async () => {
    const count = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* runMigrations("arc_migrations", arcMigrations)
        yield* sql.unsafe(`INSERT INTO workspaces (id, path, name, created_at, last_opened_at)
          VALUES ('ws_main', '/repo/main', 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
        yield* sql.unsafe(`INSERT INTO chats (id, workspace_id, title, created_at)
          VALUES ('chat_a', 'ws_main', 'a', '2026-01-01T00:00:00Z')`)
        yield* sql.unsafe(`INSERT INTO target_sessions
          (id, chat_id, provider, origin, preset, cwd, native_session_id, native_transcript_path, state, started_at)
          VALUES
          ('target_manual', 'chat_a', 'cursor', 'manual', NULL, '/repo/main', NULL, NULL, 'running', '2026-01-02T00:00:00Z'),
          ('target_worker', 'chat_a', 'cursor', 'orchestrated', NULL, '/repo/main', NULL, NULL, 'running', '2026-01-03T00:00:00Z')`)
        const rows = yield* sql.unsafe<{ c: number }>(
          `SELECT count(*) AS c FROM target_sessions WHERE chat_id = 'chat_a' AND provider = 'cursor'`,
        )
        return rows[0]?.c ?? 0
      }),
    )
    expect(count).toBe(2)
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

  it("0007 unwelds the worker: backfills one channel per (provider, preset) and points each session at the workspace whose path equals its cwd", async () => {
    // Stage the pre-split schema, seed legacy target_sessions the way today's
    // launch writes them (cwd = the chat's workspace path), then let 0007 run as
    // a pending migration — exactly the upgrade path a live DB takes. Hold back
    // 0007 AND every migration after it: the ledger only runs ids past its
    // high-water mark, so a later migration applied here would skip 0007.
    const preSplit = Object.fromEntries(
      Object.entries(arcMigrations).filter(([id]) => id < "0007_worker_comm_diff_endpoints"),
    )

    const result = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        yield* runMigrations("arc_migrations", preSplit)

        yield* sql.unsafe(`INSERT INTO workspaces (id, path, name, created_at, last_opened_at)
          VALUES ('ws_main', '/repo/main', 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'),
                 ('ws_feat', '/repo/feat', 'feat', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
        // Keep the two claude sessions on different chats to mirror the
        // historical pre-orchestration data this migration upgraded.
        yield* sql.unsafe(`INSERT INTO chats (id, workspace_id, title, created_at)
          VALUES ('chat_a', 'ws_main', 'a', '2026-01-01T00:00:00Z'),
                 ('chat_b', 'ws_feat', 'b', '2026-01-01T00:00:00Z'),
                 ('chat_c', 'ws_main', 'c', '2026-01-01T00:00:00Z')`)
        // Two claude/null sessions on different cwds (→ one shared channel, two
        // distinct workspaces), one codex/preset session, one orphan cwd.
        yield* sql.unsafe(`INSERT INTO target_sessions
          (id, chat_id, provider, preset, cwd, native_session_id, native_transcript_path, state, started_at)
          VALUES
          ('s1', 'chat_a', 'claude', NULL, '/repo/main', NULL, NULL, 'exited', '2026-01-02T00:00:00Z'),
          ('s2', 'chat_a', 'codex', 'gpt-5', '/repo/main', NULL, NULL, 'exited', '2026-01-03T00:00:00Z'),
          ('s3', 'chat_b', 'claude', NULL, '/repo/feat', NULL, NULL, 'exited', '2026-01-04T00:00:00Z'),
          ('s4', 'chat_c', 'claude', NULL, '/gone', NULL, NULL, 'exited', '2026-01-05T00:00:00Z')`)

        const cwdBefore = Object.fromEntries(
          (yield* sql.unsafe<{ id: string; cwd: string }>(`SELECT id, cwd FROM target_sessions`)).map(
            (r) => [r.id, r.cwd] as const,
          ),
        )

        yield* runMigrations("arc_migrations", arcMigrations)

        const channels = yield* sql.unsafe<{
          id: string
          provider: string
          preset: string | null
          kind: string
          model: string | null
        }>(`SELECT id, provider, preset, kind, model FROM channels ORDER BY provider, preset`)

        const sessions = yield* sql.unsafe<{
          id: string
          provider: string
          cwd: string
          channelId: string | null
          workspaceId: string | null
          wsPath: string | null
          chProvider: string | null
        }>(`SELECT ts.id, ts.provider, ts.cwd, ts.channel_id AS "channelId", ts.workspace_id AS "workspaceId",
                   w.path AS "wsPath", c.provider AS "chProvider"
            FROM target_sessions ts
            LEFT JOIN workspaces w ON w.id = ts.workspace_id
            LEFT JOIN channels c ON c.id = ts.channel_id
            ORDER BY ts.id`)

        return { cwdBefore, channels, sessions }
      }),
    )

    // One local channel per distinct (provider, preset); model null = harness default.
    expect(result.channels.map(({ id: _id, ...rest }) => rest)).toEqual([
      { provider: "claude", preset: null, kind: "local", model: null },
      { provider: "codex", preset: "gpt-5", kind: "local", model: null },
    ])
    // Channel ids are TypeIDs.
    for (const c of result.channels) expect(c.id).toMatch(/^channel_[0-9a-z]+$/)

    const byId = Object.fromEntries(result.sessions.map((s) => [s.id, s] as const))
    // Comm endpoint: every session resolves to a channel matching its own provider;
    // the two claude/null sessions share one channel id.
    for (const s of result.sessions) {
      expect(s.channelId).not.toBeNull()
      expect(s.chProvider).toBe(s.provider)
    }
    expect(byId["s1"]!.channelId).toBe(byId["s3"]!.channelId)
    expect(byId["s1"]!.channelId).not.toBe(byId["s2"]!.channelId)

    // Diff endpoint invariant: resolved workspace path equals the original cwd.
    for (const s of result.sessions.filter((s) => s.workspaceId !== null)) {
      expect(s.wsPath).toBe(result.cwdBefore[s.id])
    }
    // Orphan cwd (no workspace row) → null ref, cwd column retained as fallback.
    expect(byId["s4"]!.workspaceId).toBeNull()
    expect(byId["s4"]!.cwd).toBe("/gone")
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

  describe("ledger/record divergence fails loud", () => {
    const v1: Migrations = {
      "0001_initial": sqlMigration(`CREATE TABLE t (id TEXT PRIMARY KEY)`),
      "0002_add_note": sqlMigration(`ALTER TABLE t ADD COLUMN note TEXT`),
    }

    it("dies when an applied migration was renamed in the record", async () => {
      await expect(
        run(
          Effect.gen(function* () {
            yield* runMigrations("t_migrations", v1)
            yield* runMigrations("t_migrations", {
              "0001_initial": v1["0001_initial"]!,
              "0002_add_comment": sqlMigration(`ALTER TABLE t ADD COLUMN comment TEXT`),
            })
          }),
        ),
      ).rejects.toThrow(/names it "add_comment"/)
    })

    it("dies when an applied migration was deleted from the record", async () => {
      await expect(
        run(
          Effect.gen(function* () {
            yield* runMigrations("t_migrations", v1)
            yield* runMigrations("t_migrations", { "0001_initial": v1["0001_initial"]! })
          }),
        ),
      ).rejects.toThrow(/no longer contains/)
    })

    it("dies when a gap below the ledger high-water mark is refilled", async () => {
      const gapped: Migrations = {
        "0001_initial": v1["0001_initial"]!,
        "0003_add_flag": sqlMigration(`ALTER TABLE t ADD COLUMN flag INTEGER`),
      }
      await expect(
        run(
          Effect.gen(function* () {
            yield* runMigrations("t_migrations", gapped)
            yield* runMigrations("t_migrations", { ...gapped, "0002_add_note": v1["0002_add_note"]! })
          }),
        ),
      ).rejects.toThrow(/silently skipped/)
    })
  })
})
