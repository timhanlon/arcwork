import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { type WorkStore, WorkStoreLive } from "../src/main/work/store.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { type ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { arcId } from "../src/shared/ids.js"

/**
 * `WorkService.addCitation` is the post-creation form of create's `citations`:
 * it stamps a typed external citation (here `commit`) onto an existing work as a
 * `references` edge. This is what the commit watcher calls so a commit→work link
 * is a queryable citation, not a hand-written note. Idempotent per (work, target).
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

const gitProvenance = { source: "git-hook" as const, chatId: arcId("chat", "chat_c") }

describe("WorkService.addCitation (commit → work)", () => {
  it("stamps a commit citation onto an existing work", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "ship it", body: "x" }, { source: "mcp" })
        return yield* svc.addCitation(
          created.id,
          { kind: "commit", target: "b04086f", note: "dev: ship it" },
          gitProvenance,
        )
      }),
    )
    const commit = work.citations.find((c) => c.kind === "commit")
    expect(commit).toEqual({ kind: "commit", target: "b04086f", note: "dev: ship it" })
  })

  it("is idempotent for the same (work, kind, target)", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "once", body: "x" }, { source: "mcp" })
        yield* svc.addCitation(created.id, { kind: "commit", target: "abc123" }, gitProvenance)
        return yield* svc.addCitation(created.id, { kind: "commit", target: "abc123" }, gitProvenance)
      }),
    )
    expect(work.citations.filter((c) => c.kind === "commit" && c.target === "abc123")).toHaveLength(1)
  })

  it("records distinct shas as separate citations", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "two commits", body: "x" }, { source: "mcp" })
        yield* svc.addCitation(created.id, { kind: "commit", target: "sha_one" }, gitProvenance)
        return yield* svc.addCitation(created.id, { kind: "commit", target: "sha_two" }, gitProvenance)
      }),
    )
    const shas = work.citations.filter((c) => c.kind === "commit").map((c) => c.target).sort()
    expect(shas).toEqual(["sha_one", "sha_two"])
  })

  it("survives a reload (read back through get)", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create({ title: "persist", body: "x" }, { source: "mcp" })
        yield* svc.addCitation(created.id, { kind: "commit", target: "persisted_sha" }, gitProvenance)
        return yield* svc.get(created.id)
      }),
    )
    expect(work?.citations.some((c) => c.kind === "commit" && c.target === "persisted_sha")).toBe(true)
  })

  it("fails on unknown work", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        return yield* Effect.exit(
          svc.addCitation(arcId("work", "work_ghost"), { kind: "commit", target: "x" }, gitProvenance),
        )
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})
