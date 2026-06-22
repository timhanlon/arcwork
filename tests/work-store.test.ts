import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { WorkStore, WorkStoreLive } from "../src/main/work/store.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { WorkProvenance } from "../src/shared/work.js"
import { arcId } from "../src/shared/ids.js"

// Runs the real WorkService + WorkStore + production sqliteLayer; vitest aliases
// native `better-sqlite3` to a `node:sqlite` drop-in (see vitest.config.ts), so
// this exercises the actual graph SQL with no native build. Each test gets its
// own in-memory DB via a fresh ManagedRuntime, disposed after the program.
const WorkLive = WorkServiceLive.pipe(Layer.provide(WorkStoreLive))

const run = async <A, E>(
  program: Effect.Effect<A, E, WorkService | WorkStore>,
): Promise<A> => {
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(WorkLive, WorkStoreLive).pipe(Layer.provide(sqliteLayer(":memory:"))),
  )
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const cliProvenance: WorkProvenance = {
  source: "cli",
  actor: "claude",
  sessionId: "target_abc",
  chatId: arcId("chat", "chat_abc"),
}

describe("work create + projection (in-memory graph store)", () => {
  it("create writes a ref+node and surfaces it in open work", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const created = yield* work.create(
          { title: "decide markdown policy", body: "...", labels: ["decision", "graph"] },
          cliProvenance,
        )
        const open = yield* work.listOpen
        return { created, open }
      }),
    )

    expect(result.created._tag).toBe("Work")
    expect(result.created.id).toMatch(/^work_/)
    expect(result.created.nodeId).toMatch(/^work_rev_/)
    expect(result.created.status).toBe("open")
    expect(result.created.labels).toEqual(["decision", "graph"])
    expect(result.created.provenance).toMatchObject({ source: "cli", sessionId: "target_abc" })
    expect(result.open).toHaveLength(1)
    expect(result.open[0]!.id).toBe(result.created.id)
  })

  it("records a created_in_session provenance edge when the session is known", async () => {
    const edge = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "investigate hooks", body: "x" }, cliProvenance)
        const edges = yield* store.loadEdges(created.id, "created_in_session")
        return edges[0]
      }),
    )

    expect(edge).toBeDefined()
    expect(edge!.toId).toBe("target_abc")
    expect(edge!.family).toBe("provenance")
    expect(edge!.source).toBe("observed")
  })

  it("omits the session edge when no session context reached the tool", async () => {
    const edges = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "stray note", body: "x" }, { source: "cli" })
        return yield* store.loadEdges(created.id, "created_in_session")
      }),
    )
    expect(edges).toHaveLength(0)
  })

  it("linkTargetSession records one typed delegated_to edge and is idempotent", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "delegate me", body: "x" }, cliProvenance)
        // Link the same (work, session) twice — the second is a no-op, not a dup edge.
        yield* work.linkTargetSession(created.id, arcId("target", "target_impl"), cliProvenance)
        yield* work.linkTargetSession(created.id, arcId("target", "target_impl"), cliProvenance)
        const edges = yield* store.loadEdges(created.id, "delegated_to")
        return edges
      }),
    )

    expect(result).toHaveLength(1)
    expect(result[0]!.toId).toBe("target_impl")
    expect(result[0]!.toKind).toBe("external")
    expect(result[0]!.family).toBe("live")
  })

  it("listDelegatedTo returns a target's current work, and drops work since re-delegated elsewhere", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const onA = yield* work.create({ title: "stays on A", body: "x" }, cliProvenance)
        const movedToB = yield* work.create({ title: "moved to B", body: "x" }, cliProvenance)
        const onB = yield* work.create({ title: "only on B", body: "x" }, cliProvenance)
        yield* work.linkTargetSession(onA.id, arcId("target", "target_A"), cliProvenance)
        yield* work.linkTargetSession(movedToB.id, arcId("target", "target_A"), cliProvenance)
        // Re-delegate: movedToB's *latest* delegated_to edge now points at B.
        yield* work.linkTargetSession(movedToB.id, arcId("target", "target_B"), cliProvenance)
        yield* work.linkTargetSession(onB.id, arcId("target", "target_B"), cliProvenance)
        return {
          a: yield* work.listDelegatedTo(arcId("target", "target_A")),
          b: yield* work.listDelegatedTo(arcId("target", "target_B")),
          none: yield* work.listDelegatedTo(arcId("target", "target_missing")),
        }
      }),
    )

    // A keeps only the work whose latest edge still points at it.
    expect(result.a.map((d) => d.work.title)).toEqual(["stays on A"])
    expect(result.a[0]!.targetSessionId).toBe("target_A")
    // B has its own work plus the re-delegated one.
    expect(result.b.map((d) => d.work.title).sort()).toEqual(["moved to B", "only on B"])
    expect(result.none).toHaveLength(0)
  })

  it("round-trips citations, storing work cites as real traversable ref edges", async () => {
    const result = await run(
      Effect.gen(function* () {
        const svc = yield* WorkService
        const store = yield* WorkStore
        const created = yield* svc.create(
          {
            title: "work API",
            body: "x",
            citations: [
              { kind: "file", target: "docs/proposals/x.md", note: "reasoning trail" },
              { kind: "work", target: "work_other" },
            ],
          },
          cliProvenance,
        )
        const refs = yield* store.loadEdges(created.id, "references")
        const work = yield* svc.get(created.id)
        return { work, refs }
      }),
    )

    expect(result.work?.citations).toEqual([
      { kind: "file", target: "docs/proposals/x.md", note: "reasoning trail" },
      { kind: "work", target: "work_other" },
    ])
    // A work citation must be a real ref edge: raw ref id + to_kind 'ref', so a
    // graph query on `work_other` finds it (not the unusable `work:work_other`).
    const workEdge = result.refs.find((e) => e.toKind === "ref")
    expect(workEdge?.toId).toBe("work_other")
    // Non-work citations stay encoded external locators.
    const fileEdge = result.refs.find((e) => e.toKind === "external")
    expect(fileEdge?.toId).toBe("file:docs/proposals/x.md")
  })

  it("updateStatus records a status_set event without touching content, and drops superseded work from the queue", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "wrong work", body: "premise was false" }, cliProvenance)
        const retired = yield* work.updateStatus(created.id, "superseded", { source: "cli", actor: "claude" })
        const events = yield* store.loadEdges(created.id, "status_set")
        const open = yield* work.listOpen
        const fetched = yield* work.get(created.id)
        return { created, retired, events, openIds: open.map((w) => w.id), fetched }
      }),
    )

    // Same identity AND same content node — status is not a content revision.
    expect(result.retired.id).toBe(result.created.id)
    expect(result.retired.nodeId).toBe(result.created.nodeId)
    expect(result.retired.status).toBe("superseded")
    expect(result.retired.body).toBe("premise was false")
    // The change is an append-only status_set event on the ref (workflow family).
    expect(result.events).toHaveLength(1)
    expect(result.events[0]!.toId).toBe("superseded")
    expect(result.events[0]!.family).toBe("workflow")
    expect(result.events[0]!.fromKind).toBe("ref")
    // It leaves the open queue, but is still resolvable by ref.
    expect(result.openIds).not.toContain(result.created.id)
    expect(result.fetched?.status).toBe("superseded")
  })

  it("status is the latest event: open -> active -> done leaves three events, current 'done'", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "march", body: "x" }, cliProvenance)
        yield* work.updateStatus(created.id, "active", { source: "cli" })
        const done = yield* work.updateStatus(created.id, "done", { source: "cli" })
        const events = yield* store.loadEdges(created.id, "status_set")
        return { done, count: events.length, nodeId: created.nodeId }
      }),
    )
    expect(result.done.status).toBe("done")
    expect(result.done.nodeId).toBe(result.nodeId) // content node never changed
    expect(result.count).toBe(2) // two transitions (open is the authored default, no event)
  })

  it("revise mints a new content node, CAS-moves the ref, and keeps status (events)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "old title", body: "old body", labels: ["a"] }, cliProvenance)
        yield* work.updateStatus(created.id, "active", { source: "cli" })
        const revised = yield* work.revise(
          created.id,
          { title: "new title", labels: ["a", "b"] },
          { source: "cli", actor: "claude" },
        )
        const revises = yield* store.loadEdges(revised.nodeId, "revises")
        const open = yield* work.listOpen
        return { created, revised, revises: revises[0], open }
      }),
    )

    // Same identity, NEW content node, edited fields applied, body untouched.
    expect(result.revised.id).toBe(result.created.id)
    expect(result.revised.nodeId).not.toBe(result.created.nodeId)
    expect(result.revised.title).toBe("new title")
    expect(result.revised.body).toBe("old body")
    expect(result.revised.labels).toEqual(["a", "b"])
    // Status set before the revise survives — it lives in events, not the node.
    expect(result.revised.status).toBe("active")
    // The new node `revises` the old frozen node (exact chain).
    expect(result.revises?.toId).toBe(result.created.nodeId)
    expect(result.revises?.fromKind).toBe("node")
    // Still one row in the queue (active), now at the new revision.
    expect(result.open.find((w) => w.id === result.created.id)?.nodeId).toBe(result.revised.nodeId)
  })

  it("revise is a no-op when content is unchanged (no new node)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const created = yield* work.create({ title: "t", body: "b", labels: ["x"] }, cliProvenance)
        const same = yield* work.revise(created.id, { title: "t", labels: ["x"] }, { source: "cli" })
        return { created, same }
      }),
    )
    expect(result.same.nodeId).toBe(result.created.nodeId)
  })

  it("revise fails ArcRequestError on unknown work", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        return yield* Effect.exit(work.revise(arcId("work", "work_nope"), { title: "x" }, { source: "cli" }))
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("listForChat returns only that chat's work, any status, newest first", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        // two chats' worth of work via provenance.chatId
        const a1 = yield* work.create({ title: "a-open", body: "x" }, { source: "cli", chatId: arcId("chat", "chat_a") })
        const a2 = yield* work.create({ title: "a-done", body: "x" }, { source: "cli", chatId: arcId("chat", "chat_a") })
        yield* work.updateStatus(a2.id, "done", { source: "cli", chatId: arcId("chat", "chat_a") })
        yield* work.create({ title: "b-open", body: "x" }, { source: "cli", chatId: arcId("chat", "chat_b") })
        const forA = yield* work.listForChat(arcId("chat", "chat_a"))
        return { ids: forA.map((w) => w.id), titles: forA.map((w) => w.title), a1, a2 }
      }),
    )
    // both of chat_a's items (incl. the done one), neither of chat_b's
    expect(result.titles.sort()).toEqual(["a-done", "a-open"])
    expect(result.ids).toContain(result.a1.id)
    expect(result.ids).toContain(result.a2.id)
  })

  it("listAll returns every unit of work across statuses and chats, unlike listOpen", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const a = yield* work.create({ title: "still-open", body: "x" }, { source: "cli", chatId: arcId("chat", "chat_a") })
        const b = yield* work.create({ title: "shipped", body: "x" }, { source: "cli", chatId: arcId("chat", "chat_b") })
        yield* work.updateStatus(b.id, "done", { source: "cli" })
        const c = yield* work.create({ title: "retired", body: "x" }, { source: "cli", chatId: arcId("chat", "chat_b") })
        yield* work.updateStatus(c.id, "superseded", { source: "cli" })
        const all = yield* work.listAll
        const open = yield* work.listOpen
        return {
          allTitles: all.map((w) => w.title).sort(),
          allStatuses: Object.fromEntries(all.map((w) => [w.title, w.status])),
          openTitles: open.map((w) => w.title).sort(),
        }
      }),
    )
    // listAll surfaces resolved work that listOpen deliberately drops.
    expect(result.allTitles).toEqual(["retired", "shipped", "still-open"])
    expect(result.allStatuses).toMatchObject({ shipped: "done", retired: "superseded", "still-open": "open" })
    expect(result.openTitles).toEqual(["still-open"])
  })

  it("search matches title/body/labels, AND-ing terms, spanning every status", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        yield* work.create(
          { title: "add search to the CLI", body: "substring then FTS", labels: ["proposal", "cli"] },
          cliProvenance,
        )
        yield* work.create({ title: "fix the composer height", body: "flexbox" }, cliProvenance)
        const done = yield* work.create({ title: "search the graph", body: "x", labels: ["graph"] }, cliProvenance)
        yield* work.updateStatus(done.id, "done", { source: "cli" })

        return {
          // term in title (one) + body (other), both surface — done included.
          search: (yield* work.search({ query: "search" })).map((w) => w.title).sort(),
          // body-only match.
          fts: (yield* work.search({ query: "FTS" })).map((w) => w.title),
          // AND across terms: "search" matches both, "cli" only narrows to one.
          both: (yield* work.search({ query: "search cli" })).map((w) => w.title),
          // no match.
          none: yield* work.search({ query: "nonexistent" }),
        }
      }),
    )
    expect(result.search).toEqual(["add search to the CLI", "search the graph"])
    expect(result.fts).toEqual(["add search to the CLI"])
    expect(result.both).toEqual(["add search to the CLI"])
    expect(result.none).toHaveLength(0)
  })

  it("search filters by label (exact token) and status, and honors limit", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        yield* work.create({ title: "alpha", body: "search", labels: ["cli"] }, cliProvenance)
        yield* work.create({ title: "beta", body: "search", labels: ["client"] }, cliProvenance)
        const shipped = yield* work.create({ title: "gamma", body: "search", labels: ["cli"] }, cliProvenance)
        yield* work.updateStatus(shipped.id, "done", { source: "cli" })

        return {
          // "cli" must not match the "client" label (quoted-token match).
          label: (yield* work.search({ query: "search", labels: ["cli"] })).map((w) => w.title).sort(),
          // status filter drops the done one.
          open: (yield* work.search({ query: "search", labels: ["cli"], statuses: ["open"] })).map((w) => w.title),
          // limit caps the result set.
          limited: yield* work.search({ query: "search", limit: 1 }),
        }
      }),
    )
    expect(result.label).toEqual(["alpha", "gamma"])
    expect(result.open).toEqual(["alpha"])
    expect(result.limited).toHaveLength(1)
  })

  it("search escapes LIKE wildcards so % is a literal, not match-all", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        yield* work.create({ title: "100% done", body: "x" }, cliProvenance)
        yield* work.create({ title: "plain", body: "y" }, cliProvenance)
        return {
          literal: (yield* work.search({ query: "100%" })).map((w) => w.title),
          plain: (yield* work.search({ query: "%" })).map((w) => w.title),
        }
      }),
    )
    // "100%" matches only the one with a literal percent.
    expect(result.literal).toEqual(["100% done"])
    // A bare "%" is escaped, so it matches the literal percent row only — not all.
    expect(result.plain).toEqual(["100% done"])
  })

  it("updateStatus fails ArcRequestError on unknown work", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        return yield* Effect.exit(work.updateStatus(arcId("work", "work_does_not_exist"), "done", { source: "cli" }))
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("updateStatus is a no-op when the status is unchanged (no event written)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "stays open", body: "x", status: "open" }, cliProvenance)
        yield* work.updateStatus(created.id, "open", { source: "cli" })
        const events = yield* store.loadEdges(created.id, "status_set")
        return { events }
      }),
    )
    expect(result.events).toHaveLength(0)
  })

  it("records a supersedes live edge and excludes done work from the queue", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const replacement = yield* work.create(
          { title: "new approach", body: "x", supersedes: ["work_old"] },
          cliProvenance,
        )
        const done = yield* work.create(
          { title: "shipped thing", body: "x", status: "done" },
          cliProvenance,
        )
        const supersedes = yield* store.loadEdges(replacement.id, "supersedes")
        const open = yield* work.listOpen
        return { supersedes: supersedes[0], done, openIds: open.map((w) => w.id) }
      }),
    )

    expect(result.supersedes?.toId).toBe("work_old")
    expect(result.supersedes?.source).toBe("user_confirmed")
    expect(result.openIds).not.toContain(result.done.id)
  })

  it("create --priority writes a priority_set edge and surfaces it; unset stays null", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const ranked = yield* work.create({ title: "urgent", body: "x", priority: "p1" }, cliProvenance)
        const unranked = yield* work.create({ title: "someday", body: "y" }, cliProvenance)
        const edges = yield* store.loadEdges(ranked.id, "priority_set")
        const noEdges = yield* store.loadEdges(unranked.id, "priority_set")
        return { ranked, unranked, edge: edges[0], edgeCount: edges.length, noEdges }
      }),
    )
    expect(result.ranked.priority).toBe("p1")
    expect(result.unranked.priority).toBeNull()
    // Priority is a workflow edge even at create (no node column).
    expect(result.edgeCount).toBe(1)
    expect(result.edge!.toId).toBe("p1")
    expect(result.edge!.family).toBe("workflow")
    expect(result.edge!.fromKind).toBe("ref")
    // Unset writes no edge at all.
    expect(result.noEdges).toHaveLength(0)
  })

  it("updatePriority records a priority_set event without touching content; latest wins", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "rank me", body: "x" }, cliProvenance)
        yield* work.updatePriority(created.id, "p2", { source: "cli" })
        const bumped = yield* work.updatePriority(created.id, "p0", { source: "cli" })
        const events = yield* store.loadEdges(created.id, "priority_set")
        return { created, bumped, count: events.length }
      }),
    )
    // Same content node — priority is not a content revision.
    expect(result.bumped.id).toBe(result.created.id)
    expect(result.bumped.nodeId).toBe(result.created.nodeId)
    // Two appended events; the latest (p0) is the current priority.
    expect(result.count).toBe(2)
    expect(result.bumped.priority).toBe("p0")
  })

  it("updatePriority is a no-op when the priority is unchanged (no event written)", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const store = yield* WorkStore
        const created = yield* work.create({ title: "p1 already", body: "x", priority: "p1" }, cliProvenance)
        yield* work.updatePriority(created.id, "p1", { source: "cli" })
        const events = yield* store.loadEdges(created.id, "priority_set")
        return { events }
      }),
    )
    // The create wrote one; the re-assert wrote none.
    expect(result.events).toHaveLength(1)
  })

  it("the queue orders by priority — p0 first, p1 next, unset last", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const p1 = yield* work.create({ title: "p1 work", body: "x", priority: "p1" }, cliProvenance)
        const unset = yield* work.create({ title: "unranked", body: "x" }, cliProvenance)
        const p0 = yield* work.create({ title: "p0 work", body: "x", priority: "p0" }, cliProvenance)
        const order = (yield* work.listOpen).map((w) => w.id)
        return { order, p0: p0.id, p1: p1.id, unset: unset.id }
      }),
    )
    // Despite the unranked item being created between the two ranked ones,
    // priority decides the queue order: p0, then p1, then unset last.
    expect(result.order).toEqual([result.p0, result.p1, result.unset])
  })

  it("updatePriority fails ArcRequestError on unknown work", async () => {
    const exit = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        return yield* Effect.exit(work.updatePriority(arcId("work", "work_nope"), "p0", { source: "cli" }))
      }),
    )
    expect(exit._tag).toBe("Failure")
  })

  it("comment defaults to the current revision node and carries provenance", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const created = yield* work.create({ title: "design", body: "x" }, cliProvenance)
        const comment = yield* work.comment(created.id, { body: "Codex suggests Redis" }, cliProvenance)
        const listing = yield* work.listComments(created.id)
        return { created, comment, listing }
      }),
    )
    expect(result.comment._tag).toBe("WorkComment")
    expect(result.comment.id).toMatch(/^comment_/)
    expect(result.comment.workRefId).toBe(result.created.id)
    // Default subject is the work's current revision node.
    expect(result.comment.subjectKind).toBe("node")
    expect(result.comment.subjectId).toBe(result.created.nodeId)
    expect(result.comment.body).toBe("Codex suggests Redis")
    expect(result.comment.provenance).toMatchObject({ source: "cli", sessionId: "target_abc" })
    // It surfaces as a current-revision comment, with no older revisions yet.
    expect(result.listing.comments.map((c) => c.id)).toEqual([result.comment.id])
    expect(result.listing.currentNodeId).toBe(result.created.nodeId)
    expect(result.listing.olderRevisionCommentCount).toBe(0)
  })

  it("a comment bumps the work ref's updated_at to the comment time (recency)", async () => {
    // A comment is recent activity on the work, so it must refresh the ref's
    // recency — else fresh implementer feedback reads as stale in the monitoring
    // projection (which builds lastActivityAt off work.updatedAt).
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const created = yield* work.create({ title: "t", body: "x" }, cliProvenance)
        const before = (yield* work.get(created.id))!.updatedAt
        const comment = yield* work.comment(created.id, { body: "fresh feedback", ref: true }, cliProvenance)
        const after = (yield* work.get(created.id))!.updatedAt
        return { before, commentAt: comment.createdAt, after }
      }),
    )
    // The ref now sits at the comment's timestamp, and never moved backwards.
    expect(result.after).toBe(result.commentAt)
    expect(result.after >= result.before).toBe(true)
  })

  it("after revise, old comments stay on the old node and are not shown as current; --all-revisions returns both", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const created = yield* work.create({ title: "old", body: "x" }, cliProvenance)
        const onOld = yield* work.comment(created.id, { body: "about the old revision" }, cliProvenance)
        const revised = yield* work.revise(created.id, { title: "new" }, cliProvenance)
        const onNew = yield* work.comment(created.id, { body: "about the new revision" }, cliProvenance)

        const current = yield* work.listComments(created.id)
        const all = yield* work.listComments(created.id, { allRevisions: true })
        return { created, revised, onOld, onNew, current, all }
      }),
    )

    // The old comment stayed pinned to the old (now superseded) revision node.
    expect(result.onOld.subjectId).toBe(result.created.nodeId)
    expect(result.onNew.subjectId).toBe(result.revised.nodeId)
    expect(result.created.nodeId).not.toBe(result.revised.nodeId)

    // Default view: only the comment on the current revision.
    expect(result.current.comments.map((c) => c.id)).toEqual([result.onNew.id])
    expect(result.current.olderRevisionCommentCount).toBe(1)

    // --all-revisions: both, oldest first.
    expect(result.all.comments.map((c) => c.id)).toEqual([result.onOld.id, result.onNew.id])
    expect(result.all.olderRevisionCommentCount).toBe(1)
  })

  it("--ref comments attach to the durable ref and show in the default view across revisions", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const created = yield* work.create({ title: "old", body: "x" }, cliProvenance)
        const refComment = yield* work.comment(created.id, { body: "about the whole item", ref: true }, cliProvenance)
        // Revise — a ref comment is revision-independent, so it must still show.
        yield* work.revise(created.id, { title: "new" }, cliProvenance)
        const current = yield* work.listComments(created.id)
        return { created, refComment, current }
      }),
    )
    expect(result.refComment.subjectKind).toBe("ref")
    expect(result.refComment.subjectId).toBe(result.created.id)
    // Still in the default view after a revise, and not counted as an older-rev comment.
    expect(result.current.comments.map((c) => c.id)).toEqual([result.refComment.id])
    expect(result.current.olderRevisionCommentCount).toBe(0)
  })

  it("comment and listComments fail ArcRequestError on unknown work", async () => {
    const result = await run(
      Effect.gen(function* () {
        const work = yield* WorkService
        const commentExit = yield* Effect.exit(
          work.comment(arcId("work", "work_nope"), { body: "x" }, { source: "cli" }),
        )
        const listExit = yield* Effect.exit(work.listComments(arcId("work", "work_nope")))
        return { comment: commentExit._tag, list: listExit._tag }
      }),
    )
    expect(result.comment).toBe("Failure")
    expect(result.list).toBe("Failure")
  })
})
