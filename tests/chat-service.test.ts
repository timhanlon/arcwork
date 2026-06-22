import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ChatService, ChatServiceLive } from "../src/main/services/ChatService.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

const NOW = "2026-06-08T00:00:00.000Z"

const run = async <A, E>(
  program: Effect.Effect<A, E, ChatService | ArcStore>,
): Promise<A> => {
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

describe("ChatService title updates", () => {
  it("trims and persists manual chat titles", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        const chats = yield* ChatService
        yield* db.upsertWorkspace({
          id: arcId("workspace", "ws_1"),
          path: "/tmp/ws",
          name: "ws",
          createdAt: NOW,
          lastOpenedAt: NOW,
        })
        const chat = yield* chats.create(arcId("workspace", "ws_1"))
        const updated = yield* chats.updateTitle(chat.id, "  Better title  ")
        const listed = yield* chats.list
        return { updated, listedTitle: listed.find((item) => item.id === chat.id)?.title }
      }),
    )

    expect(result.updated.title).toBe("Better title")
    expect(result.listedTitle).toBe("Better title")
  })

  it("rejects empty titles", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        const chats = yield* ChatService
        yield* db.upsertWorkspace({
          id: arcId("workspace", "ws_1"),
          path: "/tmp/ws",
          name: "ws",
          createdAt: NOW,
          lastOpenedAt: NOW,
        })
        const chat = yield* chats.create(arcId("workspace", "ws_1"))
        return yield* Effect.exit(chats.updateTitle(chat.id, "   "))
      }),
    )

    expect(exit._tag).toBe("Failure")
  })

  it("returns the current chat for no-op edits without changing the stream state", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        const chats = yield* ChatService
        yield* db.upsertWorkspace({
          id: arcId("workspace", "ws_1"),
          path: "/tmp/ws",
          name: "ws",
          createdAt: NOW,
          lastOpenedAt: NOW,
        })
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "already named")
        const same = yield* chats.updateTitle(chat.id, "already named")
        return { chat, same }
      }),
    )

    expect(result.same).toEqual(result.chat)
  })

  it("does not let automatic title generation overwrite manual titles", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        const chats = yield* ChatService
        yield* db.upsertWorkspace({
          id: arcId("workspace", "ws_1"),
          path: "/tmp/ws",
          name: "ws",
          createdAt: NOW,
          lastOpenedAt: NOW,
        })
        const chat = yield* chats.create(arcId("workspace", "ws_1"))
        yield* chats.updateTitle(chat.id, "manual title")
        const changed = yield* chats.updateTitleIfDefault(chat.id, "generated title")
        const listed = yield* chats.list
        return { changed, title: listed.find((item) => item.id === chat.id)?.title }
      }),
    )

    expect(result.changed).toBe(false)
    expect(result.title).toBe("manual title")
  })
})

describe("assistant turn repair (Stop)", () => {
  const seed = Effect.gen(function* () {
    const db = yield* ArcStore
    yield* db.upsertWorkspace({
        id: arcId("workspace", "ws_1"),
        path: "/tmp/ws",
        name: "ws",
        createdAt: NOW,
        lastOpenedAt: NOW,
      })
      yield* db.insertChat({ id: arcId("chat", "chat_1"), workspaceId: arcId("workspace", "ws_1"), title: "c", createdAt: NOW })
      yield* db.upsertTargetSession({
        id: arcId("target", "target_1"),
        chatId: arcId("chat", "chat_1"),
        provider: "claude",
        preset: null,
        cwd: "/tmp/ws",
        nativeSessionId: "sess_1",
        nativeTranscriptPath: null,
        state: "running",
        startedAt: NOW,
      })
    })


  const streamRow = (turnId: string, dedupKey: string, body: string) => ({
    id: arcId("message", `stream_${turnId}`),
    chatId: arcId("chat", "chat_1"),
    targetSessionId: arcId("target", "target_1"),
    role: "assistant",
    turnId,
    messageId: "msg_1",
    chunkIndex: 0,
    body,
    status: "streaming",
    model: "claude",
    requestJson: null,
    occurredAt: "2026-06-08T00:00:01.000Z",
    source: "hook",
    dedupKey,
  })

  it("finalizes the streamed bubble when the Stop turn id diverges from the stream's", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* seed

        // Stream arrives under turn-1 (Claude sends turn_id on MessageDisplay).
        yield* db.upsertChatMessage(
          streamRow("turn-1", "target_1:turn-1:msg_1", "Hello"),
          "append",
        )

        // Stop arrives with a DIFFERENT turn id (no turn_id on the payload, so the
        // hook falls back to a per-payload hash) and no message_id.
        yield* db.upsertChatMessage(
          {
            id: arcId("message", "stop_row"),
            chatId: arcId("chat", "chat_1"),
            targetSessionId: arcId("target", "target_1"),
            role: "assistant",
            turnId: "sha-divergent",
            messageId: null,
            chunkIndex: null,
            body: "Hello there",
            status: "final",
            model: "claude",
            requestJson: null,
            occurredAt: "2026-06-08T00:00:02.000Z",
            source: "hook",
            dedupKey: "target_1:sha-divergent:assistant-final",
          },
          "repair_turn",
        )

        return yield* db.loadChatMessagesForChat("chat_1")
      }),
    )

    const assistant = messages.filter((m) => m.role === "assistant")
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.body).toBe("Hello there")
    expect(assistant[0]?.status).toBe("final")
  })

  it("absorbs the orphaned Stop final row when the stream lands after it (first-turn race)", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* seed

        // Cold start: the Stop hook finalizes the turn *before* any MessageDisplay
        // row exists. It carries no turn_id/message_id, so it inserts a standalone
        // `:assistant-final` placeholder under a per-payload hash turn id.
        yield* db.upsertChatMessage(
          {
            id: arcId("message", "stop_row"),
            chatId: arcId("chat", "chat_1"),
            targetSessionId: arcId("target", "target_1"),
            role: "assistant",
            turnId: "sha-divergent",
            messageId: null,
            chunkIndex: null,
            body: "Hello there",
            status: "final",
            model: "claude",
            requestJson: null,
            occurredAt: "2026-06-08T00:00:01.000Z",
            source: "hook",
            dedupKey: "target_1:sha-divergent:assistant-final",
          },
          "repair_turn",
        )

        // The stream arrives late under its own turn:message key and finalizes.
        // Without symmetric reconciliation this leaves two identical rows.
        yield* db.upsertChatMessage(
          streamRow("turn-1", "target_1:turn-1:msg_1", "Hello "),
          "append",
        )
        yield* db.upsertChatMessage(
          {
            ...streamRow("turn-1", "target_1:turn-1:msg_1", "there"),
            chunkIndex: 1,
            status: "final",
            occurredAt: "2026-06-08T00:00:02.000Z",
          },
          "append",
        )

        return yield* db.loadChatMessagesForChat("chat_1")
      }),
    )

    const assistant = messages.filter((m) => m.role === "assistant")
    expect(assistant).toHaveLength(1)
    expect(assistant[0]?.body).toBe("Hello there")
    expect(assistant[0]?.status).toBe("final")
    expect(assistant[0]?.dedupKey).toBe("target_1:turn-1:msg_1")
  })

  it("leaves a distinct earlier turn's final row untouched", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* seed

        // A genuine prior turn that finalized as a standalone assistant-final row.
        yield* db.upsertChatMessage(
          {
            id: arcId("message", "turn0_row"),
            chatId: arcId("chat", "chat_1"),
            targetSessionId: arcId("target", "target_1"),
            role: "assistant",
            turnId: "turn-0",
            messageId: null,
            chunkIndex: null,
            body: "First answer",
            status: "final",
            model: "claude",
            requestJson: null,
            occurredAt: "2026-06-08T00:00:00.500Z",
            source: "hook",
            dedupKey: "target_1:turn-0:assistant-final",
          },
          "repair_turn",
        )

        // A different turn streams and finalizes with different text — the prior
        // turn's row has a different body, so it must survive.
        yield* db.upsertChatMessage(
          { ...streamRow("turn-1", "target_1:turn-1:msg_1", "Second answer"), status: "final" },
          "append",
        )

        return yield* db.loadChatMessagesForChat("chat_1")
      }),
    )

    const bodies = messages.filter((m) => m.role === "assistant").map((m) => m.body).sort()
    expect(bodies).toEqual(["First answer", "Second answer"])
  })
})

describe("composer reconciliation", () => {
  const seed = Effect.gen(function* () {
    const db = yield* ArcStore
    yield* db.upsertWorkspace({
      id: arcId("workspace", "ws_1"),
      path: "/tmp/ws",
      name: "ws",
      createdAt: NOW,
      lastOpenedAt: NOW,
    })
    yield* db.insertChat({ id: arcId("chat", "chat_1"), workspaceId: arcId("workspace", "ws_1"), title: "c", createdAt: NOW })
    yield* db.upsertTargetSession({
      id: arcId("target", "target_1"),
      chatId: arcId("chat", "chat_1"),
      provider: "claude",
      preset: null,
      cwd: "/tmp/ws",
      nativeSessionId: "sess_1",
      nativeTranscriptPath: null,
      state: "running",
      startedAt: NOW,
    })
  })

  const userRow = (overrides: Partial<ChatMessageRow>): ChatMessageRow => ({
    id: arcId("message", "message_1"),
    chatId: arcId("chat", "chat_1"),
    targetSessionId: arcId("target", "target_1"),
    role: "user",
    turnId: null,
    messageId: null,
    chunkIndex: null,
    body: "Hello",
    status: "final",
    model: null,
    requestJson: null,
    occurredAt: NOW,
    source: "composer",
    dedupKey: "target_1:composer-user:message_1",
    ...overrides,
  })

  it("can roll back an optimistic composer row by dedup key", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* seed
        const row = userRow({})
        yield* db.upsertChatMessage(row, "insert")
        expect(yield* db.deleteChatMessageByDedupKey(row.dedupKey)).toBe(true)
        return yield* db.loadChatMessagesForChat("chat_1")
      }),
    )

    expect(messages).toHaveLength(0)
  })

  it("converges an optimistic composer row into the hook row when bodies match", async () => {
    // The optimistic composer row and the hook row are joined by exact body.
    // sendPrompt normalizes the composer body with trim() so it matches what
    // every provider reports through its hook (none keep a trailing newline) —
    // a raw "Hello\n" optimistic body would miss this join and double the message.
    const messages = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* seed
        yield* db.upsertChatMessage(
          userRow({ id: arcId("message", "composer_1"), dedupKey: "target_1:composer-user:composer_1" }),
          "insert",
        )

        const changed = yield* db.reconcileComposerOptimisticUser(
          userRow({
            id: arcId("message", "hook_1"),
            turnId: "turn_1",
            source: "hook:claude",
            dedupKey: "target_1:turn_1:user",
          }),
        )

        return { changed, messages: yield* db.loadChatMessagesForChat("chat_1") }
      }),
    )

    expect(messages.changed).toBe(true)
    expect(messages.messages.map((m) => m.dedupKey)).toEqual(["target_1:turn_1:user"])
    expect(messages.messages.map((m) => m.source)).toEqual(["hook:claude"])
  })

  it("removes stale same-body composer rows when the canonical hook row already exists", async () => {
    const messages = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* seed
        yield* db.upsertChatMessage(
          userRow({ id: arcId("message", "composer_1"), dedupKey: "target_1:composer-user:composer_1" }),
          "insert",
        )
        yield* db.upsertChatMessage(
          userRow({
            id: arcId("message", "hook_1"),
            turnId: "turn_1",
            source: "hook:claude",
            dedupKey: "target_1:turn_1:user",
          }),
          "insert",
        )

        const changed = yield* db.reconcileComposerOptimisticUser(
          userRow({
            id: arcId("message", "hook_1_again"),
            turnId: "turn_1",
            source: "hook:claude",
            dedupKey: "target_1:turn_1:user",
          }),
        )

        return { changed, messages: yield* db.loadChatMessagesForChat("chat_1") }
      }),
    )

    expect(messages.changed).toBe(false)
    expect(messages.messages.map((m) => m.dedupKey)).toEqual(["target_1:turn_1:user"])
  })
})
