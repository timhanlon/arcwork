import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { IngestStore, IngestStoreLive } from "../src/main/ingest/db/store.js"
import { sqliteLayer } from "../src/main/ingest/db/sqlite.js"
import type { ExtractedRows, MessageRow } from "../src/main/ingest/db/schema.js"

// Real production store over the node:sqlite shim (vitest aliases better-sqlite3).
const storeLayer = IngestStoreLive.pipe(Layer.provide(sqliteLayer(":memory:")))
const withStore = async <A>(program: Effect.Effect<A, unknown, IngestStore>): Promise<A> => {
  const runtime = ManagedRuntime.make(storeLayer)
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const message = (sessionId: string, i: number): MessageRow => ({
  id: `${sessionId}:msg:${i}`,
  sessionId,
  provider: "claude",
  nativeMessageId: `native-${i}`,
  role: i % 2 === 0 ? "user" : "assistant",
  createdAt: "2026-01-01T00:00:00.000Z",
  model: "claude-opus-4-8",
  text: `message ${i}`,
  thinking: null,
  rawJson: null,
  sequence: i,
  ordinal: i,
})

describe("ingest store bulk insert chunking", () => {
  it("persists a session whose row count exceeds the single-statement variable ceiling", async () => {
    // 6000 messages at 12 columns = 72,000 bound parameters — over both the
    // 32,766 SQLite ceiling and the ~2,730-row single-statement limit for this
    // table. Chunking must split it into several statements within one txn.
    const sessionId = "claude:big"
    const count = 6000
    const rows: ExtractedRows = {
      session: {
        id: sessionId,
        provider: "claude",
        nativeSessionId: "big",
        workspaceRoot: "/repo",
        title: "big session",
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sourcePath: "/repo/big.jsonl",
        rawMetadataJson: null,
      },
      messages: Array.from({ length: count }, (_, i) => message(sessionId, i)),
      toolCalls: [],
      fileHints: [],
      usageEvents: [],
      diagnostics: [],
    }

    const stored = await withStore(
      Effect.gen(function* () {
        const store = yield* IngestStore
        yield* store.replaceSession(rows)
        return yield* store.getSession(sessionId)
      }),
    )

    expect(stored).toBeDefined()
    expect(stored!.messages).toHaveLength(count)
    // Ordered by sequence, contents intact across chunk boundaries.
    expect(stored!.messages[0]!.text).toBe("message 0")
    expect(stored!.messages.at(-1)!.text).toBe(`message ${count - 1}`)
    for (let i = 0; i < count; i++) expect(stored!.messages[i]!.sequence).toBe(i)
  })

  it("re-ingesting replaces child rows rather than accumulating them", async () => {
    const sessionId = "claude:reingest"
    const build = (count: number): ExtractedRows => ({
      session: {
        id: sessionId,
        provider: "claude",
        nativeSessionId: "reingest",
        workspaceRoot: "/repo",
        title: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sourcePath: null,
        rawMetadataJson: null,
      },
      messages: Array.from({ length: count }, (_, i) => message(sessionId, i)),
      toolCalls: [],
      fileHints: [],
      usageEvents: [],
      diagnostics: [],
    })

    const counts = await withStore(
      Effect.gen(function* () {
        const store = yield* IngestStore
        yield* store.replaceSession(build(3000))
        const first = (yield* store.getSession(sessionId))!.messages.length
        yield* store.replaceSession(build(10))
        const second = (yield* store.getSession(sessionId))!.messages.length
        return { first, second }
      }),
    )

    expect(counts.first).toBe(3000)
    expect(counts.second).toBe(10)
  })
})
