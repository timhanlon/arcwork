import { Effect, Layer, ManagedRuntime, type Scope } from "effect"
import { describe, expect, it } from "vitest"
import { IngestStore, IngestStoreLive } from "../src/main/ingest/db/store.js"
import { sqliteLayer } from "../src/main/ingest/db/sqlite.js"
import { launchCodexAppServerSession } from "../src/main/ingest/providers/codex-appserver/launch.js"

// A minimal thread/turn peer (no approval) that completes one turn with a
// user + assistant message, so we can assert the turn lands in the store.
const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_persist' } } })
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } })
    send({ method: 'item/completed', params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hello' }] } } })
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'hi there', phase: 'final_answer' } } })
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  }
})
`

const run = <A, E>(program: Effect.Effect<A, E, IngestStore | Scope.Scope>): Promise<A> => {
  const runtime = ManagedRuntime.make(IngestStoreLive.pipe(Layer.provide(sqliteLayer(":memory:"))))
  return runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose())
}

describe("codex app-server launch → store", () => {
  it(
    "persists a completed turn's rows into the shared IngestStore",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* launchCodexAppServerSession(
            { launchCmd: process.execPath, args: ["-e", PEER] },
            { cwd: process.cwd() },
          )
          const turn = yield* driver.runTurn("hello")
          expect(turn.status).toBe("completed")

          const store = yield* IngestStore
          const stored = yield* store.getSession(turn.rows.session.id)
          expect(stored).toBeDefined()
          expect(stored?.session.provider).toBe("codex")
          expect(stored?.session.nativeSessionId).toBe("thr_persist")
          expect(stored?.messages.map((m) => m.role)).toEqual(["user", "assistant"])
          expect(stored?.messages.find((m) => m.role === "assistant")?.text).toBe("hi there")
        }),
      ),
    15000,
  )
})
