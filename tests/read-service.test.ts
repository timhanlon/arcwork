import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ChatService, ChatServiceLive } from "../src/main/services/ChatService.js"
import { ChatMessageService } from "../src/main/services/ChatMessageService.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { WorkStoreLive } from "../src/main/work/store.js"
import { ReadService, ReadServiceLive } from "../src/main/read/service.js"
import type { ChatMessage } from "../src/shared/chat-message.js"
import type { WorkProvenance } from "../src/shared/work.js"
import { arcId, type ChatId, type MessageId, type WorkspaceId } from "../src/shared/ids.js"

/**
 * `ReadService.search` / `.get` — the v1 core read surface
 * (`work_01kv424crtexttwx0pgwsmn787`) over the real WorkService graph + the real
 * ChatService, sharing one in-memory sqlite (vitest better-sqlite3 → node:sqlite
 * alias). Asserts the rigid result-header contract, the browse-vs-query status
 * default, structured filters, opaque cursor pagination, and batch hydration.
 *
 * The chat-message timeline path (`work_01kv4czzgxfewbps502d26r6ea`) reads
 * through {@link ChatMessageService}, stubbed here from `messageFixtures` so the
 * test exercises ReadService's own logic — rowKind/status derivation, render
 * order, chatId-scoping, and `message_…` ref routing — without standing up the
 * heavy hook-projection layer.
 */

const prov = (chatId?: ChatId): WorkProvenance => ({ source: "mcp", chatId })

// Per-test timeline rows the ChatMessageService stub serves; reset by each
// message test before `run`. Non-message tests leave it empty (no message hits).
let messageFixtures: ReadonlyArray<ChatMessage> = []

const message = (
  over: Partial<ChatMessage> & { readonly id: MessageId; readonly chatId: ChatId; readonly role: ChatMessage["role"] },
): ChatMessage => ({
  _tag: "ChatMessage",
  body: "",
  status: "final",
  occurredAt: "2026-06-08T00:00:00.000Z",
  source: "test",
  ...over,
})

const ChatMessagesStub = Layer.succeed(
  ChatMessageService,
  ChatMessageService.of({
    listForChat: (chatId) => Effect.succeed(messageFixtures.filter((m) => m.chatId === chatId)),
    getById: (id) => Effect.succeed(messageFixtures.find((m) => m.id === id) ?? null),
    listPending: Effect.succeed([]),
    changes: Stream.empty,
    ingestSignal: () => Effect.succeed(0),
    ingestArtifactSession: () => Effect.succeed(0),
    supersedePendingForTarget: () => Effect.succeed(0),
    reprojectChat: () => Effect.succeed({ deleted: 0, inserted: 0 }),
    sendPrompt: () => Effect.die("ChatMessageService.sendPrompt is unused in this test"),
  }),
)

const WorkLive = WorkServiceLive.pipe(Layer.provide(Layer.mergeAll(WorkStoreLive, ArcStoreLive)))
const ChatsLive = ChatServiceLive.pipe(Layer.provide(ArcStoreLive))
const ReadLive = ReadServiceLive.pipe(Layer.provide(Layer.mergeAll(WorkLive, ChatsLive, ChatMessagesStub, ArcStoreLive)))
const TestLayer = Layer.mergeAll(ReadLive, WorkLive, ChatsLive, ArcStoreLive).pipe(
  Layer.provide(sqliteLayer(":memory:")),
)

const run = <A, E>(
  program: Effect.Effect<A, E, ReadService | WorkService | ChatService | ArcStore>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(TestLayer)
  return runtime.runPromise(program).finally(() => runtime.dispose())
}

const insertWorkspace = (id: WorkspaceId, name: string = id) =>
  Effect.flatMap(ArcStore, (db) =>
    db.upsertWorkspace({
      id,
      path: `/tmp/${id}`,
      name,
      createdAt: "2026-06-08T00:00:00.000Z",
      lastOpenedAt: "2026-06-08T00:00:00.000Z",
    }),
  )

describe("ReadService.search", () => {
  it("ranks query matches by relevance with a rigid result header", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"))
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "design chat")
        yield* work.create({ title: "auth auth auth refactor", body: "the auth saga" }, prov(chat.id))
        yield* work.create({ title: "unrelated", body: "auth mentioned once here" }, prov(chat.id))
        yield* work.create({ title: "billing", body: "nothing to see" }, prov(chat.id))
        const result = yield* read.search({ query: "auth", filters: { chatId: chat.id } })
        return result.hits
      }),
    )

    expect(hits.map((h) => h.title)).toEqual(["auth auth auth refactor", "unrelated"])
    const top = hits[0]!
    expect(top.kind).toBe("work")
    expect(top.ref).toMatch(/^work_/)
    expect(top.score).toBeGreaterThan(hits[1]!.score ?? 0)
    expect(top.preview.length).toBeGreaterThan(0)
    expect(typeof top.updatedAt).toBe("string")
  })

  it("browsing without a query returns the open queue (done hidden); status filter reveals it", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"))
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "design chat")
        yield* work.create({ title: "open item", body: "" }, prov(chat.id))
        yield* work.create({ title: "finished item", body: "", status: "done" }, prov(chat.id))
        const browse = yield* read.search({ filters: { chatId: chat.id } })
        const withDone = yield* read.search({ filters: { chatId: chat.id, status: ["done"] } })
        return { browse: browse.hits.map((h) => h.title), done: withDone.hits.map((h) => h.title) }
      }),
    )

    expect(result.browse).toEqual(["open item"])
    expect(result.done).toEqual(["finished item"])
  })

  it("scopes search to the whole project: a worktree sees the repo's work, a plain folder stays isolated", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        const db = yield* ArcStore
        yield* db.upsertRepository({
          id: "repo_1",
          commonGitDir: "/tmp/repo/.git",
          rootPath: "/tmp/repo",
          defaultBranch: "main",
          remotesJson: "[]",
          githubOwner: null,
          githubRepo: null,
          githubNodeId: null,
          createdAt: "2026-06-08T00:00:00.000Z",
          lastSeenAt: "2026-06-08T00:00:00.000Z",
        })
        yield* insertWorkspace(arcId("workspace", "ws_main"))
        yield* insertWorkspace(arcId("workspace", "ws_wt"))
        yield* insertWorkspace(arcId("workspace", "ws_plain"))
        // main checkout and worktree share the repository; the folder has none.
        yield* db.setWorkspaceGit(arcId("workspace", "ws_main"), { repositoryId: "repo_1" })
        yield* db.setWorkspaceGit(arcId("workspace", "ws_wt"), { repositoryId: "repo_1" })

        const mainChat = yield* chats.create(arcId("workspace", "ws_main"), "main chat")
        yield* work.create({ title: "shared project work", body: "authored in main" }, prov(mainChat.id))
        const worktreeChat = yield* chats.create(arcId("workspace", "ws_wt"), "worktree chat")
        const plainChat = yield* chats.create(arcId("workspace", "ws_plain"), "plain chat")

        const fromWorktree = yield* read.search({ filters: { chatId: worktreeChat.id } })
        const fromPlain = yield* read.search({ filters: { chatId: plainChat.id } })
        return {
          fromWorktree: fromWorktree.hits.map((h) => h.title),
          fromPlain: fromPlain.hits.map((h) => h.title),
        }
      }),
    )

    expect(result.fromWorktree).toContain("shared project work")
    expect(result.fromPlain).not.toContain("shared project work")
  })

  it("hides a closed work that was commented on while open (comment-row status stays in sync)", async () => {
    // Regression: search_document keeps a `comment:` row per comment, snapshotting
    // the work's status at comment time. A status change must refresh those rows,
    // not just the `work:` ref row — otherwise a work commented-on while open and
    // later closed keeps a stale open-status comment row and re-surfaces in the
    // open queue (work_01kvbtwgdjf…, work_01kv7fj9…, +4).
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"))
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "design chat")
        const w = yield* work.create({ title: "commented then closed", body: "" }, prov(chat.id))
        yield* work.comment(w.id, { body: "a review note while still open" }, prov(chat.id))
        yield* work.updateStatus(w.id, "done", prov(chat.id))
        const browse = yield* read.search({ filters: { chatId: chat.id } })
        const withDone = yield* read.search({ filters: { chatId: chat.id, status: ["done"] } })
        return { browse: browse.hits.map((h) => h.title), done: withDone.hits.map((h) => h.title) }
      }),
    )

    // The closed work must not leak into the open queue via its stale comment row…
    expect(result.browse).toEqual([])
    // …and must still be findable under the done filter (deduped to one hit).
    expect(result.done).toEqual(["commented then closed"])
  })

  it("narrows by labels and by chatId, and selects the chat itself", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"), "ws")
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "design chat")
        yield* work.create({ title: "mcp work", body: "", labels: ["mcp"] }, prov(chat.id))
        yield* work.create({ title: "other work", body: "", labels: ["ui"] }, prov())
        const byLabel = yield* read.search({ filters: { chatId: chat.id, labels: ["mcp"] } })
        const byChat = yield* read.search({ kinds: ["work", "chat"], filters: { chatId: chat.id } })
        return {
          byLabel: byLabel.hits.map((h) => h.title),
          byChatKinds: byChat.hits.map((h) => h.kind).toSorted(),
        }
      }),
    )

    expect(result.byLabel).toEqual(["mcp work"])
    // chatId anchors work search to the workspace AND selects the chat header.
    expect(result.byChatKinds).toEqual(["chat", "work"])
  })

  it("uses chatId as a workspace anchor and has no unanchored global work search", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"), "repo-one")
        yield* insertWorkspace(arcId("workspace", "ws_2"), "repo-two")
        const chatA = yield* chats.create(arcId("workspace", "ws_1"), "repo one A")
        const chatB = yield* chats.create(arcId("workspace", "ws_1"), "repo one B")
        const chatOther = yield* chats.create(arcId("workspace", "ws_2"), "repo two")
        yield* work.create({ title: "same workspace from A", body: "needle" }, prov(chatA.id))
        yield* work.create({ title: "same workspace from B", body: "needle" }, prov(chatB.id))
        yield* work.create({ title: "other workspace", body: "needle" }, prov(chatOther.id))

        const scoped = yield* read.search({ query: "needle", filters: { chatId: chatA.id } })
        const unanchored = yield* read.search({ query: "needle" })
        return {
          scoped: scoped.hits.map((h) => h.title).toSorted(),
          unanchored: unanchored.hits,
        }
      }),
    )

    expect(result.scoped).toEqual(["same workspace from A", "same workspace from B"])
    expect(result.unanchored).toEqual([])
  })

  it("paginates with an opaque cursor and reports the true total", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"))
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "design chat")
        // Distinct scores via term repetition → deterministic relevance order.
        yield* work.create({ title: "x x x x", body: "" }, prov(chat.id))
        yield* work.create({ title: "x x x", body: "" }, prov(chat.id))
        yield* work.create({ title: "x x", body: "" }, prov(chat.id))
        yield* work.create({ title: "x", body: "" }, prov(chat.id))
        const page1 = yield* read.search({ query: "x", filters: { chatId: chat.id }, limit: 2 })
        const page2 = yield* read.search({
          query: "x",
          filters: { chatId: chat.id },
          limit: 2,
          cursor: page1.nextCursor ?? undefined,
        })
        return {
          total: page1.total,
          page1: page1.hits.map((h) => h.title),
          page2: page2.hits.map((h) => h.title),
          nextAfter2: page2.nextCursor,
        }
      }),
    )

    expect(result.total).toBe(4)
    expect(result.page1).toEqual(["x x x x", "x x x"])
    expect(result.page2).toEqual(["x x", "x"])
    expect(result.nextAfter2).toBeNull()
  })

  it("finds work through indexed comment text without exposing a new hit kind", async () => {
    const hits = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* insertWorkspace(arcId("workspace", "ws_1"))
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "design chat")
        const w = yield* work.create({ title: "planner", body: "ordinary body" }, prov(chat.id))
        yield* work.comment(w.id, { body: "handoff summary mentions flamelock" }, prov(chat.id))
        const result = yield* read.search({ query: "flamelock", filters: { chatId: chat.id } })
        return result.hits
      }),
    )

    expect(hits).toHaveLength(1)
    expect(hits[0]!.kind).toBe("work")
    expect(hits[0]!.title).toBe("planner")
    expect(hits[0]!.ref).toMatch(/^work_/)
    expect(hits[0]!.preview).toContain("flamelock")
  })
})

describe("ReadService.get", () => {
  it("batch-hydrates work (with comments) and chats, collecting unknowns in notFound", async () => {
    const result = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        const work = yield* WorkService
        const chats = yield* ChatService
        const read = yield* ReadService
        yield* db.upsertWorkspace({
          id: arcId("workspace", "ws_1"),
          path: "/tmp/ws",
          name: "ws",
          createdAt: "2026-06-08T00:00:00.000Z",
          lastOpenedAt: "2026-06-08T00:00:00.000Z",
        })
        const chat = yield* chats.create(arcId("workspace", "ws_1"), "a chat")
        const w = yield* work.create({ title: "hydrate me", body: "body text" }, prov())
        yield* work.comment(w.id, { body: "a remark" }, prov())
        const got = yield* read.get({ refs: [w.id, chat.id, "comment_unknown", "work_missing"] })
        return got
      }),
    )

    const workEntity = result.entities.find((e) => e._tag === "work")
    const chatEntity = result.entities.find((e) => e._tag === "chat")
    expect(workEntity?._tag).toBe("work")
    expect(workEntity?._tag === "work" && workEntity.work.title).toBe("hydrate me")
    expect(workEntity?._tag === "work" && workEntity.comments.length).toBe(1)
    expect(chatEntity?._tag === "chat" && chatEntity.chat.title).toBe("a chat")
    // A comment ref (no hydration path yet) and a missing work ref both land here.
    expect(result.notFound.toSorted()).toEqual(["comment_unknown", "work_missing"])
  })

  it("drops comments when include omits them, and dedups the single-ref convenience", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const read = yield* ReadService
        const w = yield* work.create({ title: "lean", body: "x" }, prov())
        yield* work.comment(w.id, { body: "ignored" }, prov())
        // Same ref via both `ref` and `refs` → one entity.
        const got = yield* read.get({ ref: w.id, refs: [w.id], include: [] })
        return got
      }),
    )

    expect(result.entities.length).toBe(1)
    const entity = result.entities[0]!
    expect(entity._tag === "work" && entity.comments.length).toBe(0)
  })

  it("hydrates a message_… ref in full and routes an unknown message id to notFound", async () => {
    messageFixtures = [
      message({ id: arcId("message", "message_real"), chatId: arcId("chat", "chat_a"), role: "assistant", body: "the full body" }),
    ]
    const result = await run(
      Effect.gen(function* () {
        const read = yield* ReadService
        return yield* read.get({ refs: ["message_real", "message_missing"] })
      }),
    )

    const entity = result.entities.find((e) => e._tag === "message")
    expect(entity?._tag).toBe("message")
    expect(entity?._tag === "message" && entity.message.body).toBe("the full body")
    expect(result.notFound).toEqual(["message_missing"])
  })
})

describe("ReadService.search — message timeline", () => {
  it("returns thin rows in render order with typed rowKind/status, scoped to the chat", async () => {
    messageFixtures = [
      message({ id: arcId("message", "message_user1"), chatId: arcId("chat", "chat_a"), role: "user", body: "please run the tool" }),
      message({
        id: arcId("message", "message_tool1"),
        chatId: arcId("chat", "chat_a"),
        role: "tool",
        payload: { kind: "tool", state: "input-available", toolName: "mcp__codex__codex", args: { p: 1 } },
      }),
      message({ id: arcId("message", "message_asst1"), chatId: arcId("chat", "chat_a"), role: "assistant", body: "done" }),
      message({ id: arcId("message", "message_other"), chatId: arcId("chat", "chat_b"), role: "user", body: "a different chat" }),
    ]
    const hits = await run(
      Effect.gen(function* () {
        const read = yield* ReadService
        const r = yield* read.search({ kinds: ["message"], filters: { chatId: arcId("chat", "chat_a") } })
        return r.hits
      }),
    )

    // chatId scopes to chat_a (chat_b's row is excluded), in render (ordinal) order.
    expect(hits.map((h) => h.ref)).toEqual(["message_user1", "message_tool1", "message_asst1"])
    expect(hits.every((h) => h.kind === "message")).toBe(true)
    const tool = hits[1]!
    expect(tool.title).toBe("mcp__codex__codex")
    expect(tool.message?.rowKind).toBe("tool")
    expect(tool.message?.toolName).toBe("mcp__codex__codex")
    expect(tool.message?.status).toBe("pending") // input-available ⇒ stuck/pending
    expect(tool.message?.ordinal).toBe(1)
    expect(hits[0]!.message?.rowKind).toBe("message")
    expect(hits[2]!.message?.status).toBe("completed") // final message
  })

  it("contributes no message hits without a chatId filter", async () => {
    messageFixtures = [message({ id: arcId("message", "message_x"), chatId: arcId("chat", "chat_a"), role: "user", body: "hi" })]
    const hits = await run(
      Effect.gen(function* () {
        const read = yield* ReadService
        const r = yield* read.search({ kinds: ["message"] })
        return r.hits
      }),
    )

    expect(hits).toEqual([])
  })

  it("keeps absolute ordinal when a query narrows the timeline", async () => {
    messageFixtures = [
      message({ id: arcId("message", "message_0"), chatId: arcId("chat", "chat_a"), role: "user", body: "alpha" }),
      message({ id: arcId("message", "message_1"), chatId: arcId("chat", "chat_a"), role: "assistant", body: "beta needle" }),
      message({ id: arcId("message", "message_2"), chatId: arcId("chat", "chat_a"), role: "assistant", body: "gamma" }),
    ]
    const hits = await run(
      Effect.gen(function* () {
        const read = yield* ReadService
        const r = yield* read.search({ kinds: ["message"], filters: { chatId: arcId("chat", "chat_a") }, query: "needle" })
        return r.hits
      }),
    )

    expect(hits.map((h) => h.ref)).toEqual(["message_1"])
    // ordinal reflects the row's position in the full timeline, not the filtered set.
    expect(hits[0]!.message?.ordinal).toBe(1)
  })
})
