import { Effect, Layer, ManagedRuntime } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { LiveTargetStateService } from "../src/main/services/LiveTargetStateService.js"
import type { LiveTargetActivity, LiveTargetState } from "../src/shared/live-target-state.js"
import { TargetSessionManager } from "../src/main/services/TargetSessionManager.js"
import { TargetInboxService, TargetInboxServiceLive } from "../src/main/services/TargetInboxService.js"
import { arcId } from "../src/shared/ids.js"

// The delivery half of orchestration: a message queued for a running target is
// pasted as its next turn only when the target is idle; mid-turn it buffers and
// flushes on the next turn boundary. A real in-memory ArcStore backs the inbox
// (exercises the SQL); the session manager + live-state projection are stubbed so
// the test drives "is it idle?" and observes what gets pasted.

const WS = arcId("workspace", "workspace_test")
const CHAT = arcId("chat", "chat_test")
const TARGET = arcId("target", "target_test")

// Controllable per-test state shared by the stubs.
let activity: LiveTargetActivity
let submitAccepted: boolean
const submits: Array<{ readonly instanceId: string; readonly text: string }> = []

const states = (): ReadonlyArray<LiveTargetState> => [
  { targetSessionId: TARGET, chatId: CHAT, activity },
]

const SessionsStub = Layer.succeed(TargetSessionManager, {
  submit: (req: { readonly instanceId: string; readonly text: string }) =>
    Effect.sync(() => {
      submits.push(req)
      return { accepted: submitAccepted }
    }),
} as never)

const LiveStub = Layer.succeed(LiveTargetStateService, {
  list: Effect.sync(states),
} as never)

const StoreLive = ArcStoreLive.pipe(Layer.provide(sqliteLayer(":memory:")))
const AppLayer = Layer.mergeAll(
  StoreLive,
  TargetInboxServiceLive.pipe(Layer.provide(StoreLive), Layer.provide(SessionsStub), Layer.provide(LiveStub)),
)

let runtime: ManagedRuntime.ManagedRuntime<ArcStore | TargetInboxService, SqlError>

const seed = Effect.gen(function* () {
  const store = yield* ArcStore
  yield* store.upsertWorkspace({
    id: WS,
    path: "/tmp/arc-test",
    name: "test",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  })
  yield* store.insertChat({ id: CHAT, workspaceId: WS, title: "test", createdAt: "2026-01-01T00:00:00.000Z" })
  yield* store.upsertTargetSession({
    id: TARGET,
    chatId: CHAT,
    provider: "cursor",
    origin: "orchestrated",
    preset: null,
    cwd: "/tmp/arc-test",
    nativeSessionId: null,
    nativeTranscriptPath: null,
    state: "running",
    startedAt: "2026-01-01T00:00:00.000Z",
  })
})

const pendingCount = Effect.gen(function* () {
  const store = yield* ArcStore
  return (yield* store.listPendingTargetMessages(TARGET)).length
})

beforeEach(async () => {
  activity = "idle"
  submitAccepted = true
  submits.length = 0
  runtime = ManagedRuntime.make(AppLayer)
  await runtime.runPromise(seed)
})

afterEach(async () => {
  await runtime.dispose()
})

describe("TargetInboxService delivery", () => {
  it("pastes immediately and acks when the target is idle", async () => {
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.enqueue(TARGET, "do the thing")))
    expect(submits).toEqual([{ instanceId: TARGET, text: "do the thing" }])
    expect(await runtime.runPromise(pendingCount)).toBe(0)
  })

  it("buffers without pasting while the target is mid-turn, then flushes on idle", async () => {
    activity = "generating"
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.enqueue(TARGET, "later")))
    expect(submits).toEqual([]) // mid-turn: held, not pasted
    expect(await runtime.runPromise(pendingCount)).toBe(1)

    activity = "idle" // turn closed
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.flushTo(TARGET)))
    expect(submits).toEqual([{ instanceId: TARGET, text: "later" }])
    expect(await runtime.runPromise(pendingCount)).toBe(0)
  })

  it("delivers messages queued mid-turn as a single labelled batch", async () => {
    activity = "generating"
    await runtime.runPromise(
      Effect.flatMap(TargetInboxService, (inbox) =>
        inbox.enqueue(TARGET, "first", "alice").pipe(Effect.andThen(inbox.enqueue(TARGET, "second", "bob"))),
      ),
    )
    expect(submits).toEqual([])

    activity = "idle"
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.flushTo(TARGET)))
    expect(submits).toHaveLength(1)
    expect(submits[0]!.text).toContain("alice")
    expect(submits[0]!.text).toContain("first")
    expect(submits[0]!.text).toContain("bob")
    expect(submits[0]!.text).toContain("second")
    expect(await runtime.runPromise(pendingCount)).toBe(0)
  })

  it("serializes concurrent flushes so a queued message is pasted only once", async () => {
    // The enqueue path and the controller's turn-close path can both call flushTo
    // at once; the flush lock must let only one win the pending rows. Without it
    // both read the same `delivered_at IS NULL` batch and double-paste.
    activity = "generating" // queue without auto-flushing
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.enqueue(TARGET, "once")))
    expect(submits).toEqual([])

    activity = "idle"
    await runtime.runPromise(
      Effect.flatMap(TargetInboxService, (inbox) =>
        Effect.all([inbox.flushTo(TARGET), inbox.flushTo(TARGET)], { concurrency: "unbounded" }),
      ),
    )
    expect(submits).toHaveLength(1) // one paste, not two
    expect(await runtime.runPromise(pendingCount)).toBe(0)
  })

  it("does not ack when the PTY is gone (no live session to accept the paste)", async () => {
    submitAccepted = false
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.enqueue(TARGET, "into the void")))
    expect(submits).toHaveLength(1) // attempted
    expect(await runtime.runPromise(pendingCount)).toBe(1) // still pending — redelivers later
  })

  it("an unattributed lone message is pasted verbatim (reads as a plain user turn)", async () => {
    await runtime.runPromise(Effect.flatMap(TargetInboxService, (inbox) => inbox.enqueue(TARGET, "just this")))
    expect(submits[0]!.text).toBe("just this")
  })
})
