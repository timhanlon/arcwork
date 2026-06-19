import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"

// Runs the real ArcStore + production sqliteLayer; vitest aliases the native
// `better-sqlite3` to a `node:sqlite` drop-in (see vitest.config.ts), so this
// exercises the actual store SQL with no native build or ABI mismatch.
//
// Each test gets its own in-memory DB: a fresh ManagedRuntime builds the layer
// graph independently, so the SqliteClient (and its DB) is isolated, and
// ArcStoreLive runs its versioned migrations at open. Disposed after the program.
const runDb = async <A, E>(program: Effect.Effect<A, E, ArcStore>): Promise<A> => {
  const runtime = ManagedRuntime.make(ArcStoreLive.pipe(Layer.provide(sqliteLayer(":memory:"))))
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const NOW = "2026-06-06T00:00:00.000Z"

// chat_messages.chat_id -> chats(id) -> workspaces(id); target_session_id has no
// FK. Seed the two parents so request rows can be inserted.
const seed = Effect.gen(function* () {
  const db = yield* ArcStore
  yield* db.upsertWorkspace({
    id: "ws_1",
    path: "/tmp/arc-test-ws",
    name: "ws",
    createdAt: NOW,
    lastOpenedAt: NOW,
  })
  yield* db.insertChat({ id: "chat_1", workspaceId: "ws_1", title: "t", createdAt: NOW })
})

const msg = (over: Partial<ChatMessageRow> & { id: string; dedupKey: string }): ChatMessageRow => ({
  chatId: "chat_1",
  targetSessionId: "target_1",
  role: "request",
  turnId: null,
  messageId: null,
  chunkIndex: null,
  body: "[Question]",
  status: "pending",
  model: null,
  requestJson: null,
  occurredAt: NOW,
  source: "test",
  ...over,
})

const questionJson = (state: string, extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: "question", state, questions: [{ prompt: "Cats or dogs?", options: [] }], ...extra })

const permissionJson = (state: string, toolName = "Bash", extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: "permission", state, toolName, ...extra })

const toolJson = (state: string, toolName = "Bash", extra: Record<string, unknown> = {}): string =>
  JSON.stringify({ kind: "tool", state, toolName, ...extra })

const parseState = (requestJson: string | null): string | undefined => {
  if (!requestJson) return undefined
  const value = JSON.parse(requestJson) as { state?: string }
  return value.state
}

describe("pending request lifecycle (in-memory store)", () => {
  it("supersede marks a target's pending rows final + superseded and drops them from the pending list", async () => {
    const result = await runDb(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        yield* db.upsertChatMessage(
          msg({ id: "m1", dedupKey: "target_1:request:tool_1", requestJson: questionJson("pending") }),
          "insert",
        )

        const before = yield* db.loadPendingRequests
        const cleared = yield* db.supersedePendingRequestsForTarget("target_1")
        const after = yield* db.loadPendingRequests
        const rows = yield* db.loadChatMessagesForChat("chat_1")
        return { before: before.length, cleared, after: after.length, row: rows[0]! }
      }),
    )

    expect(result.before).toBe(1)
    expect(result.cleared).toBe(1)
    expect(result.after).toBe(0)
    expect(result.row.status).toBe("final")
    expect(parseState(result.row.requestJson)).toBe("superseded")
  })

  it("converges hook + artifact projections of one request onto a single row, resolution monotonic", async () => {
    const key = "target_1:request:tool_1"
    const result = await runDb(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        // hook projects the pending request
        yield* db.upsertChatMessage(
          msg({ id: "m1", dedupKey: key, requestJson: questionJson("pending") }),
          "replace",
        )
        // artifact re-projection (same tool id => same key) carries the answer
        yield* db.upsertChatMessage(
          msg({ id: "m2", dedupKey: key, status: "final", requestJson: questionJson("answered", { answer: "Cats" }) }),
          "replace_keep_time",
        )
        // a later artifact lacking tool output must NOT reopen the answered request
        yield* db.upsertChatMessage(
          msg({ id: "m3", dedupKey: key, requestJson: questionJson("pending") }),
          "replace_keep_time",
        )

        const rows = yield* db.loadChatMessagesForChat("chat_1")
        const pending = yield* db.loadPendingRequests
        return { rowCount: rows.length, row: rows[0]!, pending: pending.length }
      }),
    )

    expect(result.rowCount).toBe(1) // converged, not duplicated
    expect(parseState(result.row.requestJson)).toBe("answered")
    expect(result.row.status).toBe("final")
    expect(result.pending).toBe(0)
  })

  it("revives a superseded request to pending when an authoritative re-projection proves it still open", async () => {
    const key = "target_1:request:tool_1"
    const result = await runDb(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        yield* db.upsertChatMessage(msg({ id: "m1", dedupKey: key, requestJson: questionJson("pending") }), "insert")
        yield* db.supersedePendingRequestsForTarget("target_1")
        // resume re-ingest: the question is genuinely still open (no answer yet)
        yield* db.upsertChatMessage(
          msg({ id: "m2", dedupKey: key, requestJson: questionJson("pending") }),
          "replace_keep_time",
        )

        const rows = yield* db.loadChatMessagesForChat("chat_1")
        const pending = yield* db.loadPendingRequests
        return { rowCount: rows.length, row: rows[0]!, pending: pending.length }
      }),
    )

    expect(result.rowCount).toBe(1)
    expect(parseState(result.row.requestJson)).toBe("pending")
    expect(result.row.status).toBe("pending")
    expect(result.pending).toBe(1)
  })

  it("pending list ignores legacy permission rows and only reports durable questions", async () => {
    const result = await runDb(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        yield* db.upsertChatMessage(
          msg({ id: "p1", dedupKey: "target_1:request:p1", requestJson: permissionJson("pending") }),
          "insert",
        )
        yield* db.upsertChatMessage(
          msg({ id: "q1", dedupKey: "target_1:request:q1", requestJson: questionJson("pending") }),
          "insert",
        )

        const pending = yield* db.loadPendingRequests
        return pending.map((r) => r.requestJson && JSON.parse(r.requestJson).kind)
      }),
    )

    // The SQL filters the pending list to durable questions: the legacy permission
    // row is excluded while the question remains pending (present in the list).
    expect(result).toEqual(["question"])
  })

  it("reconciles both the user row and the request row across a --resume re-ingest (stable keys)", async () => {
    // Keys are session-independent, so a pre-resume row and its post-resume
    // re-projection (new arc message id, new native session) collapse in place.
    const userKey = "target_1:turn-1:user"
    const requestKey = "target_1:request:tool_1"
    const result = await runDb(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        // pre-resume
        yield* db.upsertChatMessage(
          msg({ id: "u1", role: "user", dedupKey: userKey, body: "do the thing", status: "final" }),
          "insert",
        )
        yield* db.upsertChatMessage(
          msg({ id: "r1", dedupKey: requestKey, requestJson: questionJson("pending") }),
          "replace",
        )
        // post-resume re-ingest: same keys, new ids, request now answered
        yield* db.upsertChatMessage(
          msg({ id: "u2", role: "user", dedupKey: userKey, body: "do the thing", status: "final" }),
          "insert",
        )
        yield* db.upsertChatMessage(
          msg({ id: "r2", dedupKey: requestKey, status: "final", requestJson: questionJson("answered", { answer: "Cats" }) }),
          "replace_keep_time",
        )

        const rows = yield* db.loadChatMessagesForChat("chat_1")
        return {
          users: rows.filter((r) => r.role === "user").length,
          requests: rows.filter((r) => r.role === "request"),
        }
      }),
    )

    expect(result.users).toBe(1) // user row reconciled, not duplicated
    expect(result.requests).toHaveLength(1) // request row reconciled, not duplicated
    expect(parseState(result.requests[0]!.requestJson)).toBe("answered")
  })

  it("does not apply request-state status merging to tool rows", async () => {
    const key = "target_1:tool:tool_1"
    const result = await runDb(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        yield* db.upsertChatMessage(
          msg({
            id: "t1",
            role: "tool",
            dedupKey: key,
            body: "[Tool: Bash]",
            status: "pending",
            requestJson: toolJson("input-available"),
          }),
          "replace",
        )
        yield* db.upsertChatMessage(
          msg({
            id: "t2",
            role: "tool",
            dedupKey: key,
            body: "[Tool: Bash]",
            status: "pending",
            requestJson: toolJson("input-available"),
          }),
          "replace_keep_time",
        )
        const rows = yield* db.loadChatMessagesForChat("chat_1")
        return rows[0]!
      }),
    )

    expect(result.role).toBe("tool")
    expect(result.status).toBe("pending")
    expect(parseState(result.requestJson)).toBe("input-available")
  })
})
