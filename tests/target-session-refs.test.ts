import { Effect, Layer, ManagedRuntime } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { arcId } from "../src/shared/ids.js"

// ArcStore over a fresh in-memory DB (migrations run on layer build); the
// vitest shim aliases better-sqlite3 → node:sqlite. provideMerge keeps SqlClient
// in the output context so the test can seed/poke rows directly alongside the
// store API.
const run = async <A>(program: Effect.Effect<A, unknown, ArcStore | SqlClient>): Promise<A> => {
  const runtime = ManagedRuntime.make(ArcStoreLive.pipe(Layer.provideMerge(sqliteLayer(":memory:"))))
  try {
    return await runtime.runPromise(program as Effect.Effect<A, unknown, ArcStore | SqlClient>)
  } finally {
    await runtime.dispose()
  }
}

describe("target session reads resolve through the comm + diff endpoints", () => {
  it("loadTargetSessions takes provider/preset from the channel and cwd from the workspace, not the inlined columns", async () => {
    const session = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        const db = yield* ArcStore

        yield* sql.unsafe(`INSERT INTO workspaces (id, path, name, created_at, last_opened_at)
          VALUES ('ws1', '/repo/main', 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
        yield* sql.unsafe(`INSERT INTO chats (id, workspace_id, title, created_at)
          VALUES ('chatX', 'ws1', 'x', '2026-01-01T00:00:00Z')`)

        // Create a worker; the store derives its channel + workspace refs.
        yield* db.upsertTargetSession({
          id: arcId("target", "tsX"),
          chatId: arcId("chat", "chatX"),
          provider: "claude",
          preset: null,
          cwd: "/repo/main",
          nativeSessionId: null,
          nativeTranscriptPath: null,
          state: "running",
          startedAt: "2026-01-02T00:00:00Z",
        })

        // Corrupt the inlined columns; the endpoint refs are untouched. If the
        // read still returns the right values, the refs are load-bearing.
        yield* sql.unsafe(
          `UPDATE target_sessions SET cwd = '/STALE', provider = 'STALE', preset = 'STALE' WHERE id = 'tsX'`,
        )

        const sessions = yield* db.loadTargetSessions
        return sessions.find((s) => s.id === "tsX")!
      }),
    )

    expect(session.cwd).toBe("/repo/main") // workspaces.path via workspace_id
    expect(session.provider).toBe("claude") // channels.provider via channel_id
    expect(session.preset).toBeNull()
    expect(session.channelId).not.toBeNull()
    expect(session.workspaceId).toBe("ws1")
  })

  it("falls back to the inlined cwd for a worker whose cwd matches no workspace (orphan diff endpoint)", async () => {
    const session = await run(
      Effect.gen(function* () {
        const sql = yield* SqlClient
        const db = yield* ArcStore

        yield* sql.unsafe(`INSERT INTO workspaces (id, path, name, created_at, last_opened_at)
          VALUES ('ws1', '/repo/main', 'main', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`)
        yield* sql.unsafe(`INSERT INTO chats (id, workspace_id, title, created_at)
          VALUES ('chatX', 'ws1', 'x', '2026-01-01T00:00:00Z')`)

        // cwd points outside any known workspace → workspace_id stays null.
        yield* db.upsertTargetSession({
          id: arcId("target", "tsO"),
          chatId: arcId("chat", "chatX"),
          provider: "codex",
          preset: null,
          cwd: "/nowhere",
          nativeSessionId: null,
          nativeTranscriptPath: null,
          state: "running",
          startedAt: "2026-01-02T00:00:00Z",
        })

        const sessions = yield* db.loadTargetSessions
        return sessions.find((s) => s.id === "tsO")!
      }),
    )

    expect(session.workspaceId).toBeNull()
    expect(session.cwd).toBe("/nowhere") // inlined fallback
    expect(session.channelId).not.toBeNull() // comm endpoint still resolves
    expect(session.provider).toBe("codex")
  })
})
