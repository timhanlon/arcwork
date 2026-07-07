import { ConfigProvider, Effect, Layer, ManagedRuntime } from "effect"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { WorkStore, WorkStoreLive } from "../src/main/work/store.js"
import {
  ChatSummaryDistiller,
  ChatSummaryDistillerLive,
} from "../src/main/summary/distiller.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"
import { arcId, type ChatId, type MessageId } from "../src/shared/ids.js"

// Real ArcStore + WorkStore + distiller over an in-memory DB (vitest aliases
// better-sqlite3 to node:sqlite). `fetch` is stubbed with canned LM Studio
// responses, so decode + persistence + idempotency are exercised end-to-end with
// no live server. LM Studio config is injected through a per-test ConfigProvider
// (not process.env) so the distiller's enabled/model settings are deterministic.
type Deps = ChatSummaryDistiller | ArcStore | WorkStore

const run = async <A, E>(
  program: Effect.Effect<A, E, Deps>,
  env: Record<string, string> = { ARC_LMSTUDIO_ENABLED: "true" },
): Promise<A> => {
  const Sqlite = sqliteLayer(":memory:")
  const Stores = Layer.mergeAll(ArcStoreLive, WorkStoreLive).pipe(Layer.provide(Sqlite))
  const Config = ConfigProvider.layer(ConfigProvider.fromUnknown(env))
  const App = Layer.mergeAll(Stores, ChatSummaryDistillerLive.pipe(Layer.provide(Stores))).pipe(
    Layer.provide(Config),
  )
  const runtime = ManagedRuntime.make(App)
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const NOW = "2026-06-06T00:00:00.000Z"
const CHAT: ChatId = arcId("chat", "chat_summary_1")

const seed = Effect.gen(function* () {
  const db = yield* ArcStore
  yield* db.upsertWorkspace({
    id: arcId("workspace", "ws_1"),
    path: "/tmp/arc-summary-ws",
    name: "ws",
    createdAt: NOW,
    lastOpenedAt: NOW,
  })
  yield* db.insertChat({ id: CHAT, workspaceId: arcId("workspace", "ws_1"), title: "t", createdAt: NOW })
  const msg = (id: string, over: Partial<ChatMessageRow>): ChatMessageRow => ({
    id: arcId("message", id) as MessageId,
    chatId: CHAT,
    targetSessionId: arcId("target", "target_1"),
    role: "user",
    turnId: null,
    messageId: null,
    chunkIndex: null,
    body: "",
    status: "final",
    model: null,
    requestJson: null,
    injectedFromTargetSessionId: null,
    injectedTargetMessageId: null,
    occurredAt: NOW,
    source: "test",
    dedupKey: id,
    ...over,
  })
  yield* db.upsertChatMessage(msg("m1", { role: "user", body: "integrate the app-server" }), "insert")
  yield* db.upsertChatMessage(
    msg("m2", { role: "assistant", body: "here is the plan", occurredAt: "2026-06-06T00:00:01.000Z" }),
    "insert",
  )
})

const SUMMARY = "## Primary Request and Intent\nIntegrate the codex app-server.\n## Remaining Work\nnone"

const okResponse = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })

let fetchMock: ReturnType<typeof vi.fn>

const stubFetch = (completion: () => Response) => {
  fetchMock = vi.fn((url: string | URL) => {
    const u = String(url)
    if (u.endsWith("/models")) return Promise.resolve(okResponse({ data: [{ id: "test-model" }] }))
    if (u.endsWith("/chat/completions")) return Promise.resolve(completion())
    return Promise.resolve(new Response("not found", { status: 404 }))
  })
  vi.stubGlobal("fetch", fetchMock)
}

const completionCalls = () =>
  fetchMock.mock.calls.filter(([u]) => String(u).endsWith("/chat/completions")).length

afterEach(() => {
  vi.unstubAllGlobals()
})

describe("ChatSummaryDistiller", () => {
  it("distills, decodes the completion, and persists a summary node", async () => {
    stubFetch(() =>
      okResponse({
        choices: [{ message: { content: SUMMARY } }],
        usage: { prompt_tokens: 1200, completion_tokens: 300 },
      }),
    )

    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const distiller = yield* ChatSummaryDistiller
        const summary = yield* distiller.distill(CHAT)
        const latest = yield* distiller.latest(CHAT)
        return { summary, latest }
      }),
    )

    expect(result.summary._tag).toBe("ChatSummary")
    expect(result.summary.id).toMatch(/^summary_/)
    expect(result.summary.body).toBe(SUMMARY)
    expect(result.summary.model).toBe("test-model")
    expect(result.summary.promptVersion).toBe(1)
    expect(result.summary.inputHash).toMatch(/^[0-9a-f]{64}$/)
    expect(result.summary.usage).toEqual({ promptTokens: 1200, completionTokens: 300 })
    expect(result.summary.durationMs).not.toBeNull()
    // GetChatSummary surfaces the same persisted row.
    expect(result.latest?.id).toBe(result.summary.id)
  })

  it("is idempotent: re-distilling identical input returns the existing summary without a second model call", async () => {
    stubFetch(() =>
      okResponse({ choices: [{ message: { content: SUMMARY } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    )

    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const distiller = yield* ChatSummaryDistiller
        const first = yield* distiller.distill(CHAT)
        const second = yield* distiller.distill(CHAT)
        return { first, second }
      }),
    )

    expect(result.second.id).toBe(result.first.id)
    // Only the first distill hit /chat/completions; the second short-circuited.
    expect(completionCalls()).toBe(1)
  })

  it("insertSummary is idempotent on the identity tuple: the second identical-key row is rejected and the first wins", async () => {
    stubFetch(() => okResponse({ choices: [{ message: { content: SUMMARY } }] }))

    const key = { chatId: CHAT, model: "test-model", promptVersion: 1, inputHash: "a".repeat(64) }
    const firstId = arcId("summary", "s_first")
    const base = {
      chatId: CHAT,
      workspaceId: arcId("workspace", "ws_1"),
      body: SUMMARY,
      model: "test-model",
      promptVersion: 1,
      inputHash: "a".repeat(64),
      promptTokens: null,
      completionTokens: null,
      durationMs: null,
    }

    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const work = yield* WorkStore
        const first = yield* work.insertSummary({ ...base, id: firstId, createdAt: NOW })
        const second = yield* work.insertSummary({
          ...base,
          id: arcId("summary", "s_second"),
          createdAt: "2026-06-06T00:00:05.000Z",
        })
        const winner = yield* work.loadSummaryByKey(key)
        return { first, second, winnerId: winner?.id }
      }),
    )

    expect(result.first).toBe(true)
    expect(result.second).toBe(false)
    // The later-timestamped duplicate never persisted, so the first row still wins the lookup.
    expect(result.winnerId).toBe(firstId)
  })

  it("collapses concurrent distills of the same inputs to a single summary", async () => {
    stubFetch(() =>
      okResponse({ choices: [{ message: { content: SUMMARY } }], usage: { prompt_tokens: 10, completion_tokens: 5 } }),
    )

    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const distiller = yield* ChatSummaryDistiller
        const [a, b] = yield* Effect.all([distiller.distill(CHAT), distiller.distill(CHAT)], {
          concurrency: "unbounded",
        })
        const latest = yield* distiller.latest(CHAT)
        return { a, b, latestId: latest?.id }
      }),
    )

    expect(result.a.id).toBe(result.b.id)
    expect(result.latestId).toBe(result.a.id)
  })

  it("fails with a malformed-response error when the completion has no content", async () => {
    stubFetch(() => okResponse({ choices: [{ message: {} }] }))

    const error = await run(
      Effect.gen(function* () {
        yield* seed
        const distiller = yield* ChatSummaryDistiller
        return yield* Effect.flip(distiller.distill(CHAT))
      }),
    )

    expect(error._tag).toBe("arc/summary/MalformedResponse")
  })

  it("fails with a disabled error when LM Studio support is off", async () => {
    stubFetch(() => okResponse({ choices: [{ message: { content: SUMMARY } }] }))

    const error = await run(
      Effect.gen(function* () {
        yield* seed
        const distiller = yield* ChatSummaryDistiller
        return yield* Effect.flip(distiller.distill(CHAT))
      }),
      { ARC_LMSTUDIO_ENABLED: "false" },
    )

    expect(error._tag).toBe("arc/summary/LocalModelDisabled")
    expect(completionCalls()).toBe(0)
  })
})
