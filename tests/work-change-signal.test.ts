import { Effect, Fiber, Layer, ManagedRuntime, Ref, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { type WorkStore, WorkStoreLive } from "../src/main/work/store.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { type ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { WorkChange } from "../src/shared/work.js"
import { arcId } from "../src/shared/ids.js"

/**
 * Part (A) of the `arc:work` push channel: `WorkService.changes` must fire once
 * per *real* mutation so the renderer can invalidate its work reads — and must
 * stay silent on a no-op edit, or every pane would refetch on nothing.
 *
 * Verified main-side (the renderer rewiring has no test harness — vitest only
 * includes `tests/**`). A forked collector subscribes first, then a mix of real
 * mutations and no-ops runs; the collected emissions must match the real ones.
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

const prov = { source: "rpc" as const, chatId: arcId("chat", "chat_sig") }

describe("WorkService change signal", () => {
  it("fires per real mutation, carrying the ref + chat, and stays silent on no-ops", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService

        // Subscribe first, draining every emission into a Ref.
        const seen = yield* Ref.make<ReadonlyArray<WorkChange>>([])
        const collector = yield* work.changes.pipe(
          Stream.runForEach((c) => Ref.update(seen, (a) => [...a, c])),
          Effect.forkChild,
        )
        // Let the forked subscription attach before publishing (in-memory PubSub
        // only delivers to current subscribers).
        yield* Effect.sleep("25 millis")

        const created = yield* work.create({ title: "sig", body: "b" }, prov) // emit
        yield* work.updateStatus(created.id, "active", prov) // emit
        yield* work.updateStatus(created.id, "active", prov) // no-op: same status
        yield* work.updatePriority(created.id, "p1", prov) // emit
        yield* work.revise(created.id, { title: "sig v2" }, prov) // emit
        yield* work.revise(created.id, { title: "sig v2" }, prov) // no-op: identical content
        yield* work.comment(created.id, { body: "note" }, prov) // emit

        // Let any (erroneous) trailing emission land, then stop collecting.
        yield* Effect.sleep("50 millis")
        yield* Fiber.interrupt(collector)
        return { refId: created.id, changes: yield* Ref.get(seen) }
      }),
    )

    // Five real mutations emit; the two no-ops do not.
    expect(result.changes).toHaveLength(5)
    for (const change of result.changes) {
      expect(change.refId).toBe(result.refId)
      expect(change.chatId).toBe("chat_sig")
    }
  })
})
