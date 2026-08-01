import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { WorkStore, WorkStoreLive } from "../src/main/work/store.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { type ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { arcId } from "../src/shared/ids.js"

/**
 * Citations are editable after creation: `addCitation` stamps one on (covered by
 * commit-citation.test.ts) and `removeCitation` retracts one. Retraction is an
 * appended `references_removed` edge rather than a deleted row, so the checks
 * here are about the *fold* — what the work reads as now — plus the guarantee
 * that the retracted edge is still in the graph and a later re-add revives it.
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

const prov = { source: "mcp" as const }

describe("WorkService.removeCitation", () => {
  it("drops one citation and leaves the rest", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create(
          {
            title: "edit me",
            body: "x",
            citations: [
              { kind: "pr", target: "412" },
              { kind: "commit", target: "b04086f" },
            ],
          },
          prov,
        )
        return yield* svc.removeCitation(created.id, { kind: "pr", target: "412" }, prov)
      }),
    )
    expect(work.citations).toEqual([{ kind: "commit", target: "b04086f" }])
  })

  it("identifies the citation by (kind, target) — a note never selects it", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create(
          { title: "annotated", body: "x", citations: [{ kind: "url", target: "https://a", note: "why" }] },
          prov,
        )
        return yield* svc.removeCitation(created.id, { kind: "url", target: "https://a" }, prov)
      }),
    )
    expect(work.citations).toEqual([])
  })

  it("retracts a work→work citation (a ref endpoint, not an encoded locator)", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const cited = yield* svc.create({ title: "cited", body: "x" }, prov)
        const created = yield* svc.create(
          { title: "citer", body: "x", citations: [{ kind: "work", target: cited.id }] },
          prov,
        )
        return yield* svc.removeCitation(created.id, { kind: "work", target: cited.id }, prov)
      }),
    )
    expect(work.citations).toEqual([])
  })

  it("keeps the retracted edge in the graph — removal is history, not a delete", async () => {
    const edges = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const store = yield* WorkStore
        const created = yield* svc.create(
          { title: "auditable", body: "x", citations: [{ kind: "commit", target: "sha_gone" }] },
          prov,
        )
        yield* svc.removeCitation(created.id, { kind: "commit", target: "sha_gone" }, prov)
        return {
          added: yield* store.loadEdges(created.id, "references"),
          removed: yield* store.loadEdges(created.id, "references_removed"),
        }
      }),
    )
    expect(edges.added.map((e) => e.toId)).toEqual(["commit:sha_gone"])
    expect(edges.removed.map((e) => e.toId)).toEqual(["commit:sha_gone"])
  })

  it("re-adding a removed citation revives it with its new note", async () => {
    const work = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const created = yield* svc.create(
          { title: "revived", body: "x", citations: [{ kind: "url", target: "https://a", note: "first" }] },
          prov,
        )
        yield* svc.removeCitation(created.id, { kind: "url", target: "https://a" }, prov)
        return yield* svc.addCitation(created.id, { kind: "url", target: "https://a", note: "second" }, prov)
      }),
    )
    expect(work.citations).toEqual([{ kind: "url", target: "https://a", note: "second" }])
  })

  it("removing a citation the work does not carry writes nothing", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const store = yield* WorkStore
        const created = yield* svc.create(
          { title: "untouched", body: "x", citations: [{ kind: "commit", target: "sha_one" }] },
          prov,
        )
        const work = yield* svc.removeCitation(created.id, { kind: "commit", target: "never_cited" }, prov)
        return { work, removed: yield* store.loadEdges(created.id, "references_removed") }
      }),
    )
    expect(result.work.citations).toEqual([{ kind: "commit", target: "sha_one" }])
    expect(result.removed).toEqual([])
  })

  it("fails on unknown work", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        return yield* Effect.exit(
          svc.removeCitation(arcId("work", "work_ghost"), { kind: "commit", target: "x" }, prov),
        )
      }),
    )
    expect(exit._tag).toBe("Failure")
  })
})
