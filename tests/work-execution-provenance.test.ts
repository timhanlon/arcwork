import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { type WorkStore, WorkStoreLive } from "../src/main/work/store.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { ChatMessageRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

/**
 * Execution provenance: a work write through Arc MCP carries only trusted ids
 * (`sessionId`/`chatId`); arc resolves the *observed* harness + model of that
 * session at write time and stamps them on the work. The harness is the session's
 * stable launch provider; the model is the latest one seen on its transcript — so
 * a mid-session model switch is reflected, not the launch default.
 *
 * Unlike the pure work-store test, this wires the real ArcStore over the same
 * in-memory DB so `providerForTargetSession` / `latestModelForTargetSession` have
 * sessions and transcript rows to resolve against (the vitest `node:sqlite` shim
 * stands in for native better-sqlite3).
 */
const WorkLive = WorkServiceLive.pipe(Layer.provide(Layer.mergeAll(WorkStoreLive, ArcStoreLive)))

const run = async <A, E>(
  program: Effect.Effect<A, E, WorkService | WorkStore | ArcStore>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(WorkLive, WorkStoreLive, ArcStoreLive).pipe(Layer.provide(sqliteLayer(":memory:"))),
  )
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const message = (over: Partial<ChatMessageRow> & Pick<ChatMessageRow, "id" | "occurredAt">): ChatMessageRow => ({
  chatId: arcId("chat", "chat_exec"),
  targetSessionId: arcId("target", "target_exec"),
  role: "assistant",
  turnId: null,
  messageId: null,
  chunkIndex: null,
  body: "…",
  status: "final",
  model: null,
  requestJson: null,
  injectedFromTargetSessionId: null,
  injectedTargetMessageId: null,
  source: "hook",
  dedupKey: over.id,
  ...over,
})

/** Seed a workspace + chat + codex target session with an observed transcript. */
const seedSession = Effect.gen(function* () {
  const arc = yield* ArcStore
  yield* arc.upsertWorkspace({
    id: arcId("workspace", "workspace_exec"),
    path: "/tmp/exec",
    name: "exec",
    createdAt: "2026-06-17T00:00:00.000Z",
    lastOpenedAt: "2026-06-17T00:00:00.000Z",
  })
  yield* arc.insertChat({
    id: arcId("chat", "chat_exec"),
    workspaceId: arcId("workspace", "workspace_exec"),
    title: "exec",
    createdAt: "2026-06-17T00:00:00.000Z",
  })
  yield* arc.upsertTargetSession({
    id: arcId("target", "target_exec"),
    chatId: arcId("chat", "chat_exec"),
    provider: "codex",
    preset: null,
    cwd: "/tmp/exec",
    nativeSessionId: null,
    nativeTranscriptPath: null,
    state: "running",
    startedAt: "2026-06-17T00:00:00.000Z",
  })
})

const execProvenance = { source: "mcp" as const, sessionId: "target_exec" }

describe("work execution provenance (resolved from the trusted session)", () => {
  it("stamps the session's harness and latest observed model on a created work", async () => {
    const work = await run(
      Effect.gen(function* () {
        yield* seedSession
        const arc = yield* ArcStore
        // Two observed models on the session; the newer one is the live model.
        yield* arc.upsertChatMessage(
          message({ id: arcId("message", "msg_old"), occurredAt: "2026-06-17T01:00:00.000Z", model: "gpt-5" }),
          "insert",
        )
        yield* arc.upsertChatMessage(
          message({ id: arcId("message", "msg_new"), occurredAt: "2026-06-17T02:00:00.000Z", model: "gpt-5.4" }),
          "insert",
        )
        const svc = yield* WorkService
        return yield* svc.create({ title: "from codex", body: "x" }, execProvenance)
      }),
    )
    expect(work.provenance.source).toBe("mcp")
    expect(work.provenance.execution).toEqual({ harness: "codex", model: "gpt-5.4" })
  })

  it("resolves harness even when no model has been observed yet (model omitted)", async () => {
    const work = await run(
      Effect.gen(function* () {
        yield* seedSession
        const svc = yield* WorkService
        return yield* svc.create({ title: "no model yet", body: "x" }, execProvenance)
      }),
    )
    expect(work.provenance.execution).toEqual({ harness: "codex" })
  })

  it("omits execution entirely when the session is unknown", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        return yield* svc.create({ title: "stray", body: "x" }, { source: "mcp", sessionId: "target_ghost" })
      }),
    )
    expect(work.provenance.execution).toBeUndefined()
  })

  it("persists execution across a reload (read back through get)", async () => {
    const work = await run(
      Effect.gen(function* () {
        yield* seedSession
        const arc = yield* ArcStore
        yield* arc.upsertChatMessage(
          message({ id: arcId("message", "msg_x"), occurredAt: "2026-06-17T01:00:00.000Z", model: "gpt-5.4" }),
          "insert",
        )
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "persist", body: "x" }, execProvenance)
        return yield* svc.get(created.id)
      }),
    )
    expect(work?.provenance.execution).toEqual({ harness: "codex", model: "gpt-5.4" })
  })

  it("carries the observed execution onto a comment's provenance", async () => {
    const comment = await run(
      Effect.gen(function* () {
        yield* seedSession
        const arc = yield* ArcStore
        yield* arc.upsertChatMessage(
          message({ id: arcId("message", "msg_c"), occurredAt: "2026-06-17T01:00:00.000Z", model: "gpt-5.4" }),
          "insert",
        )
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "design", body: "x" }, execProvenance)
        return yield* svc.comment(created.id, { body: "codex weighs in" }, execProvenance)
      }),
    )
    expect(comment.provenance.execution).toEqual({ harness: "codex", model: "gpt-5.4" })
  })

  it("a later model on a revise updates the work's execution model", async () => {
    const revised = await run(
      Effect.gen(function* () {
        yield* seedSession
        const arc = yield* ArcStore
        yield* arc.upsertChatMessage(
          message({ id: arcId("message", "msg_1"), occurredAt: "2026-06-17T01:00:00.000Z", model: "gpt-5" }),
          "insert",
        )
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "evolves", body: "old" }, execProvenance)
        // Session switches models, then revises the work — the new model is observed.
        yield* arc.upsertChatMessage(
          message({ id: arcId("message", "msg_2"), occurredAt: "2026-06-17T03:00:00.000Z", model: "gpt-5.4" }),
          "insert",
        )
        return yield* svc.revise(created.id, { body: "new" }, execProvenance)
      }),
    )
    expect(revised.provenance.execution).toEqual({ harness: "codex", model: "gpt-5.4" })
  })
})
