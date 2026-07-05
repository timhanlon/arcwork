import { Effect, Fiber, Layer, ManagedRuntime, type Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { arcId } from "../src/shared/ids.js"
import { IngestStore, IngestStoreLive } from "../src/main/ingest/db/store.js"
import { sqliteLayer } from "../src/main/ingest/db/sqlite.js"
import { CodexDriverRegistry, CodexDriverRegistryLive } from "../src/main/services/CodexDriverRegistry.js"
import { RpcSessionManager, RpcSessionManagerLive } from "../src/main/services/RpcSessionManager.js"

// A thread/turn peer that asks for approval (request id 501) then completes.
const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_mgr' } } })
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } })
    send({ method: 'item/completed', params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] } } })
    send({ id: 501, method: 'item/commandExecution/requestApproval', params: { itemId: 'call_1', command: 'echo hi', availableDecisions: ['accept', 'cancel'] } })
  } else if (m.method == null && m.id === 501) {
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'done', phase: 'final_answer' } } })
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    send({ method: 'serverRequest/resolved', params: { requestId: 501 } })
  }
})`

// Reports a per-process thread id, so two spawns are distinguishable — used to
// prove concurrent launches of the same target id spawn exactly one driver.
const PID_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_' + process.pid } } })
})
`

const run = <A, E>(
  program: Effect.Effect<A, E, RpcSessionManager | CodexDriverRegistry | IngestStore | Scope.Scope>,
): Promise<A> => {
  const stores = IngestStoreLive.pipe(Layer.provide(sqliteLayer(":memory:")))
  const layer = Layer.mergeAll(
    RpcSessionManagerLive.pipe(Layer.provide(Layer.mergeAll(CodexDriverRegistryLive, stores))),
    CodexDriverRegistryLive,
    stores,
  )
  const runtime = ManagedRuntime.make(layer)
  return runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose())
}

describe("RpcSessionManager", () => {
  it(
    "launches, registers approvals, submits a turn, persists, and stops",
    () =>
      run(
        Effect.gen(function* () {
          const manager = yield* RpcSessionManager
          const registry = yield* CodexDriverRegistry
          const store = yield* IngestStore

          const launched = yield* manager.launch({
            chatId: arcId("chat", "chat_1"),
            targetSessionId: arcId("target", "target_1"),
            provider: "codex",
            startedAt: "2026-06-11T00:00:00.000Z",
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PEER],
          })
          expect(launched.nativeSessionId).toBe("thr_mgr") // thread id bound onto the session
          expect(yield* manager.list).toContain("target_1")
          // The live session surfaces for the unified WatchSessions view.
          expect((yield* manager.sessions).map((s) => s.id)).toContain("target_1")

          // Answer the approval through the registry — proves launch registered the driver.
          yield* registry.changes.pipe(
            Stream.filter((list) => list.length > 0),
            Stream.take(1),
            Stream.runForEach((list) =>
              registry.answerApproval(list[0]!.targetSessionId, list[0]!.approvals[0]!.id, "accept"),
            ),
            Effect.forkScoped,
          )

          const res = yield* manager.submit({ targetSessionId: "target_1", text: "hi" })
          expect(res.accepted).toBe(true)
          expect(res.status).toBe("completed")
          expect(res.rows?.session.nativeSessionId).toBe("thr_mgr")

          // The turn landed in the shared store (indistinguishable from a scraped session).
          const stored = yield* store.listSessions()
          expect(stored.some((s) => s.provider === "codex" && s.nativeSessionId === "thr_mgr")).toBe(true)

          // Stop tears the session down: manager forgets it, registry deregisters.
          expect(yield* manager.stop("target_1")).toEqual({ stopped: true })
          expect(yield* manager.list).toHaveLength(0)
          expect(yield* manager.sessions).toHaveLength(0)
          expect(yield* registry.pending).toHaveLength(0)
        }),
      ),
    15000,
  )

  it(
    "marks the session generating while a turn is in flight, then clears it",
    () =>
      run(
        Effect.gen(function* () {
          const manager = yield* RpcSessionManager
          const registry = yield* CodexDriverRegistry
          yield* manager.launch({
            chatId: arcId("chat", "chat_1"),
            targetSessionId: arcId("target", "target_1"),
            provider: "codex",
            startedAt: "2026-06-11T00:00:00.000Z",
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PEER],
          })
          expect(yield* manager.generating).toHaveLength(0)

          // Run the turn in the background — the PEER blocks it on an approval, so
          // it stays in flight while we observe the signal.
          const turn = yield* Effect.forkScoped(manager.submit({ targetSessionId: "target_1", text: "hi" }))

          // Once the approval is pending, the turn is mid-flight → generating is set.
          yield* registry.changes.pipe(Stream.filter((l) => l.length > 0), Stream.take(1), Stream.runDrain)
          expect(yield* manager.generating).toContain("target_1")

          // Answer it; the turn completes and the marker clears.
          const pending = yield* registry.pending
          yield* registry.answerApproval(
            pending[0]!.targetSessionId,
            pending[0]!.approvals[0]!.id,
            "accept",
          )
          const res = yield* Fiber.join(turn)
          expect(res.accepted).toBe(true)
          expect(yield* manager.generating).toHaveLength(0)
        }),
      ),
    15000,
  )

  it(
    "serializes concurrent launches of the same id — one driver, idempotent",
    () =>
      run(
        Effect.gen(function* () {
          const manager = yield* RpcSessionManager
          const req = {
            chatId: arcId("chat", "chat_dup"),
            targetSessionId: arcId("target", "dup"),
            provider: "codex",
            startedAt: "2026-06-11T00:00:00.000Z",
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PID_PEER],
          }
          // Two concurrent launches of the same id (a double-clicked resume). The
          // launch lock makes the idempotency check atomic, so the second returns
          // the first's session — one process spawned, no orphaned driver. The peer
          // reports its pid as the thread id, so a second spawn would differ.
          const [a, b] = yield* Effect.all([manager.launch(req), manager.launch(req)], {
            concurrency: 2,
          })
          expect(a.nativeSessionId).toBe(b.nativeSessionId)
          expect(yield* manager.list).toHaveLength(1)
        }),
      ),
    15000,
  )
})
