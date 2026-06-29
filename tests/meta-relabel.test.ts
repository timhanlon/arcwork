import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ChatService, ChatServiceLive } from "../src/main/services/ChatService.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

const NOW = "2026-06-08T00:00:00.000Z"

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

const hookUserRow = (
  chatId: string,
  body: string,
  dedupKey: string,
  targetSessionId = "tgt_1",
): ChatMessageRow => ({
  id: arcId("message", `msg_${dedupKey}`),
  chatId: arcId("chat", chatId),
  targetSessionId: arcId("target", targetSessionId),
  role: "user",
  turnId: "turn_1",
  messageId: null,
  chunkIndex: null,
  body,
  status: "final",
  model: null,
  requestJson: null,
  injectedFromTargetSessionId: null,
  injectedTargetMessageId: null,
  occurredAt: NOW,
  source: "hook:claude",
  dedupKey,
})

const setup = (program: (chatId: string) => Effect.Effect<unknown, unknown, ChatService | ArcStore>) =>
  Effect.gen(function* () {
    const db = yield* ArcStore
    const chats = yield* ChatService
    yield* db.upsertWorkspace({ id: arcId("workspace", "ws_1"), path: "/tmp/ws", name: "ws", createdAt: NOW, lastOpenedAt: NOW })
    const chat = yield* chats.create(arcId("workspace", "ws_1"))
    return yield* program(chat.id)
  })

describe("meta relabel of hook-projected user rows", () => {
  it("flips a hook user row to meta and re-keys it", async () => {
    const result = await run(
      setup((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(
            hookUserRow(chatId, "wakeup: close out the work", "tgt_1:turn_1:user"),
            "insert",
          )
          const relabelled = yield* db.relabelHookUserAsMeta({
            targetSessionId: "tgt_1",
            body: "wakeup: close out the work",
            dedupKey: "tgt_1:meta:m1",
            messageId: "m1",
          })
          const rows = yield* db.loadChatMessagesForChat(chatId)
          return { relabelled, rows }
        }),
      ),
    ) as { relabelled: boolean; rows: ReadonlyArray<ChatMessageRow> }

    expect(result.relabelled).toBe(true)
    expect(result.rows).toHaveLength(1)
    expect(result.rows[0]!.role).toBe("meta")
    expect(result.rows[0]!.dedupKey).toBe("tgt_1:meta:m1")
    expect(result.rows[0]!.messageId).toBe("m1")
  })

  it("is idempotent: a second relabel finds nothing to flip", async () => {
    const result = await run(
      setup((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(hookUserRow(chatId, "wakeup", "tgt_1:turn_1:user"), "insert")
          const args = { targetSessionId: "tgt_1", body: "wakeup", dedupKey: "tgt_1:meta:m1", messageId: "m1" }
          const first = yield* db.relabelHookUserAsMeta(args)
          const second = yield* db.relabelHookUserAsMeta(args)
          const rows = yield* db.loadChatMessagesForChat(chatId)
          return { first, second, count: rows.length }
        }),
      ),
    ) as { first: boolean; second: boolean; count: number }

    expect(result.first).toBe(true)
    expect(result.second).toBe(false)
    expect(result.count).toBe(1)
  })

  it("ignores composer optimistic rows (key not ending in :user)", async () => {
    const result = await run(
      setup((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(
            hookUserRow(chatId, "typed by hand", "tgt_1:composer-user:c1"),
            "insert",
          )
          const relabelled = yield* db.relabelHookUserAsMeta({
            targetSessionId: "tgt_1",
            body: "typed by hand",
            dedupKey: "tgt_1:meta:m1",
            messageId: "m1",
          })
          const rows = yield* db.loadChatMessagesForChat(chatId)
          return { relabelled, role: rows[0]!.role }
        }),
      ),
    ) as { relabelled: boolean; role: string }

    expect(result.relabelled).toBe(false)
    expect(result.role).toBe("user")
  })

  it("never relabels a sibling target's identical-bodied row in the same chat", async () => {
    // Two targets share one chat (e.g. a Claude and a Codex session) and both
    // carry a user row with the exact same body. The Claude artifact re-ingest
    // must relabel only its own target's row, leaving the sibling untouched.
    const result = await run(
      setup((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          yield* db.upsertChatMessage(
            hookUserRow(chatId, "shared body", "tgt_claude:turn_1:user", "tgt_claude"),
            "insert",
          )
          yield* db.upsertChatMessage(
            hookUserRow(chatId, "shared body", "tgt_codex:turn_9:user", "tgt_codex"),
            "insert",
          )
          const relabelled = yield* db.relabelHookUserAsMeta({
            targetSessionId: "tgt_claude",
            body: "shared body",
            dedupKey: "tgt_claude:meta:m1",
            messageId: "m1",
          })
          const rows = yield* db.loadChatMessagesForChat(chatId)
          const byTarget = (t: string) => rows.find((r) => r.targetSessionId === t)!
          return { relabelled, claude: byTarget("tgt_claude").role, codex: byTarget("tgt_codex").role }
        }),
      ),
    ) as { relabelled: boolean; claude: string; codex: string }

    expect(result.relabelled).toBe(true)
    expect(result.claude).toBe("meta")
    expect(result.codex).toBe("user")
  })

  it("returns false when no hook user row matches (skill injection path)", async () => {
    const result = await run(
      setup((chatId) =>
        Effect.gen(function* () {
          const db = yield* ArcStore
          return yield* db.relabelHookUserAsMeta({
            targetSessionId: "tgt_1",
            body: "Base directory for this skill: /skills/foo",
            dedupKey: "tgt_1:meta:m1",
            messageId: "m1",
          })
        }),
      ),
    ) as boolean

    expect(result).toBe(false)
  })
})
