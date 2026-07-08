import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ChatService, ChatServiceLive } from "../src/main/services/ChatService.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

const NOW = "2026-06-11T00:00:00.000Z"

const run = async <A, E>(program: Effect.Effect<A, E, ChatService | ArcStore>): Promise<A> => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(ChatServiceLive.pipe(Layer.provide(ArcStoreLive)), ArcStoreLive).pipe(
      Layer.provide(sqliteLayer(":memory:")),
    ),
  )
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const row = (chatId: string, over: Partial<ChatMessageRow> = {}): ChatMessageRow => ({
  id: arcId("message", "msg_1"),
  chatId: arcId("chat", chatId),
  targetSessionId: arcId("target", "tgt_1"),
  role: "assistant",
  turnId: null,
  messageId: null,
  chunkIndex: null,
  body: "hello",
  status: "final",
  model: null,
  requestJson: null,
  injectedFromTargetSessionId: null,
  injectedTargetMessageId: null,
  occurredAt: NOW,
  source: "artifact:claude",
  dedupKey: "tgt_1:assistant:msg_1",
  ...over,
})

const withChat = <A, E>(
  program: (chatId: string) => Effect.Effect<A, E, ChatService | ArcStore>,
) =>
  Effect.gen(function* () {
    const db = yield* ArcStore
    const chats = yield* ChatService
    yield* db.upsertWorkspace({ id: arcId("workspace", "ws_1"), path: "/tmp/ws", name: "ws", createdAt: NOW, lastOpenedAt: NOW })
    const chat = yield* chats.create(arcId("workspace", "ws_1"))
    return yield* program(chat.id)
  })

describe("upsertChatMessage no-op skip", () => {
  it("a re-upsert of a byte-identical row is a no-op (returns false)", async () => {
    const result = await run(
      withChat((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          const r = row(chatId)
          const first = yield* db.upsertChatMessage(r, "replace_keep_time")
          const second = yield* db.upsertChatMessage(r, "replace_keep_time")
          return { first, second }
        }),
      ),
    )
    expect(result.first).toBe(true) // inserted
    expect(result.second).toBe(false) // unchanged → skipped
  })

  it("a changed body still writes (returns true)", async () => {
    const changed = await run(
      withChat((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(row(chatId), "replace_keep_time")
          return yield* db.upsertChatMessage(row(chatId, { body: "hello world" }), "replace_keep_time")
        }),
      ),
    )
    expect(changed).toBe(true)
  })

  it("filling a previously-null COALESCE column writes once, then is a no-op", async () => {
    const result = await run(
      withChat((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(row(chatId), "replace_keep_time") // model null
          const fill = yield* db.upsertChatMessage(row(chatId, { model: "gpt" }), "replace_keep_time")
          const same = yield* db.upsertChatMessage(row(chatId, { model: "gpt" }), "replace_keep_time")
          // model omitted now — COALESCE keeps the stored "gpt", so still a no-op.
          const omit = yield* db.upsertChatMessage(row(chatId, { model: null }), "replace_keep_time")
          return { fill, same, omit }
        }),
      ),
    )
    expect(result.fill).toBe(true) // null → "gpt" is a real change
    expect(result.same).toBe(false) // identical
    expect(result.omit).toBe(false) // COALESCE(null, "gpt") = "gpt", unchanged
  })

  it("occurred_at participates only in replace, not replace_keep_time", async () => {
    const result = await run(
      withChat((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(row(chatId), "replace_keep_time")
          const later = "2026-06-11T09:00:00.000Z"
          // replace_keep_time never writes occurred_at, so a new time is still a no-op.
          const keepTime = yield* db.upsertChatMessage(row(chatId, { occurredAt: later }), "replace_keep_time")
          // replace does write occurred_at, so the new time is a real change.
          const replace = yield* db.upsertChatMessage(row(chatId, { occurredAt: later }), "replace")
          return { keepTime, replace }
        }),
      ),
    )
    expect(result.keepTime).toBe(false)
    expect(result.replace).toBe(true)
  })
})
