import { EventEmitter } from "node:events"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { IngestStoreLive } from "../src/main/ingest/db/store.js"
import { CodexDriverRegistryLive } from "../src/main/services/CodexDriverRegistry.js"
import { ChatServiceLive } from "../src/main/services/ChatService.js"
import { ProviderRegistryLive } from "../src/main/services/ProviderRegistry.js"
import { RpcSessionManager, RpcSessionManagerLive } from "../src/main/services/RpcSessionManager.js"
import {
  SessionRuntimeRouter,
  SessionRuntimeRouterLive,
} from "../src/main/services/SessionRuntimeRouter.js"
import { TargetSessionManager } from "../src/main/services/TargetSessionManager.js"
import { WorkspaceServiceLive } from "../src/main/services/WorkspaceService.js"

const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_router' } } })
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } })
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'ok', phase: 'final_answer' } } })
    send({ method: 'turn/completed', params: { turn: { status: 'completed' } } })
  }
})
`

// PTY manager isn't launched here — only its submit is exercised (the non-rpc
// dispatch branch), which reports the session isn't attached.
const stubPty = Layer.succeed(
  TargetSessionManager,
  TargetSessionManager.of({
    list: Effect.succeed([]),
    changes: Stream.empty,
    launch: () => Effect.die("pty launch unused"),
    resume: () => Effect.die("pty resume unused"),
    stop: () => Effect.succeed({ stopped: false }),
    bindNative: () => Effect.void,
    submit: () => Effect.succeed({ accepted: false }),
    write: () => Effect.void,
    resize: () => Effect.void,
    events: new EventEmitter(),
  }),
)

const run = <A, E>(program: Effect.Effect<A, E, SessionRuntimeRouter | RpcSessionManager>): Promise<A> => {
  const sql = sqliteLayer(":memory:")
  const arc = ArcStoreLive.pipe(Layer.provide(sql))
  const ingest = IngestStoreLive.pipe(Layer.provide(sql))
  const rpc = RpcSessionManagerLive.pipe(Layer.provide(CodexDriverRegistryLive), Layer.provide(ingest))
  const base = Layer.mergeAll(
    arc,
    rpc,
    ProviderRegistryLive,
    WorkspaceServiceLive.pipe(Layer.provide(arc)),
    ChatServiceLive.pipe(Layer.provide(arc)),
    stubPty,
  )
  const runtime = ManagedRuntime.make(SessionRuntimeRouterLive.pipe(Layer.provideMerge(base)))
  return runtime.runPromise(program).finally(() => runtime.dispose())
}

describe("SessionRuntimeRouter dispatch", () => {
  it(
    "routes submit/stop/ownsRpc by which manager owns the session",
    () =>
      run(
        Effect.gen(function* () {
          const router = yield* SessionRuntimeRouter
          const rpc = yield* RpcSessionManager

          // Launch an rpc session directly, then drive it through the router.
          yield* rpc.launch({
            chatId: "chat_1",
            targetSessionId: "t1",
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PEER],
          })

          expect(yield* router.ownsRpc("t1")).toBe(true)
          expect(yield* router.ownsRpc("unknown")).toBe(false)

          // Owned by rpc → routes there, and carries the turn rows for projection.
          const rpcTurn = yield* router.submit({ instanceId: "t1", text: "hi" })
          expect(rpcTurn.accepted).toBe(true)
          expect(rpcTurn.rows?.session.nativeSessionId).toBe("thr_router")

          // Not owned by rpc → falls through to the PTY manager (stub: not attached).
          const ptyTurn = yield* router.submit({ instanceId: "unknown", text: "hi" })
          expect(ptyTurn.accepted).toBe(false)
          expect("rows" in ptyTurn).toBe(false)

          // Stop routes to rpc and the session leaves the aggregate.
          expect(yield* router.stop({ sessionId: "t1" })).toEqual({ stopped: true })
          expect(yield* router.ownsRpc("t1")).toBe(false)
        }),
      ),
    15000,
  )
})
