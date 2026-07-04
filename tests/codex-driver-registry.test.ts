import { Effect, ManagedRuntime, type Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { makeCodexAppServerDriver } from "../src/main/ingest/providers/codex-appserver/driver.js"
import { CodexDriverRegistry, CodexDriverRegistryLive } from "../src/main/services/CodexDriverRegistry.js"

// Scripted thread/turn peer that asks for approval mid-turn (request id 501) and
// completes once answered. Mirrors the driver test's peer.
const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_reg' } } })
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } })
    send({ method: 'turn/started', params: { turn: { id: 't1' } } })
    send({ id: 501, method: 'item/commandExecution/requestApproval', params: { approvalId: 'appr_1', itemId: 'call_1', command: 'echo hi', availableDecisions: ['accept', 'cancel'] } })
  } else if (m.method == null && m.id === 501) {
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'done', phase: 'final_answer' } } })
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
    send({ method: 'serverRequest/resolved', params: { requestId: 501 } })
  }
})
`

const run = <A, E>(program: Effect.Effect<A, E, CodexDriverRegistry | Scope.Scope>): Promise<A> => {
  const runtime = ManagedRuntime.make(CodexDriverRegistryLive)
  return runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose())
}

describe("codex driver registry", () => {
  it(
    "aggregates a session's approvals and routes the answer to its driver",
    () =>
      run(
        Effect.gen(function* () {
          const registry = yield* CodexDriverRegistry
          const driver = yield* makeCodexAppServerDriver({
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PEER],
          })
          yield* registry.register({ chatId: "chat_1", targetSessionId: "target_1", driver })

          // Answer through the REGISTRY (not the driver) — proves routing by session.
          yield* registry.changes.pipe(
            Stream.filter((list) => list.length > 0),
            Stream.take(1),
            Stream.runForEach((list) => {
              const session = list[0]!
              expect(session.targetSessionId).toBe("target_1")
              expect(session.chatId).toBe("chat_1")
              const approval = session.approvals[0]!
              expect(approval.approvalId).toBe("appr_1")
              expect(approval.itemId).toBe("call_1")
              expect(approval.availableDecisions).toContain("accept")
              return registry.answerApproval(session.targetSessionId, approval.id, "accept")
            }),
            Effect.forkScoped,
          )

          const result = yield* driver.runTurn("hi")
          expect(result.status).toBe("completed")

          // serverRequest/resolved → driver ref → mirror → aggregate empties.
          const pending = yield* registry.pending
          expect(pending).toHaveLength(0)
        }),
      ),
    15000,
  )
})
