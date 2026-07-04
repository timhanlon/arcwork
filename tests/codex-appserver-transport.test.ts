import { Effect, type Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  AppServerTransportError,
  makeAppServerTransport,
} from "../src/main/ingest/providers/codex-appserver/transport.js"

// A scripted NDJSON JSON-RPC peer (stands in for `codex app-server`, no auth /
// network). On `initialize` it answers, then emits one notification and one
// server→client request; `boom` returns a JSON-RPC error; a client response to
// request id 777 (the approval) is echoed back as an `approval/echo`
// notification so the test can prove `respond` reached the peer.
const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') {
    send({ id: m.id, result: { ok: true } })
    send({ method: 'turn/started', params: { n: 1 } })
    send({ id: 777, method: 'item/commandExecution/requestApproval', params: { itemId: 'call_x' } })
  } else if (m.method === 'boom') {
    send({ id: m.id, error: { code: 1, message: 'nope' } })
  } else if (m.method == null && m.id === 777) {
    send({ method: 'approval/echo', params: m.result })
  }
})
`

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(program))

describe("codex app-server transport", () => {
  it(
    "round-trips a request, surfaces a JSON-RPC error, and delivers notifications + server requests",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* makeAppServerTransport({ command: process.execPath, args: ["-e", PEER] })

          // request → response
          const res = yield* t.request("initialize", { clientInfo: { name: "test" } })
          expect(res).toEqual({ ok: true })

          // a JSON-RPC error becomes a typed failure (flip: error → success value)
          const failure = yield* Effect.flip(t.request("boom"))
          expect(failure).toBeInstanceOf(AppServerTransportError)

          // the peer's server→client request (buffered during initialize) → answer it
          yield* t.serverRequests.pipe(
            Stream.take(1),
            Stream.runForEach((req) => {
              expect(req.id).toBe(777)
              expect(req.method).toContain("requestApproval")
              expect(req.params).toMatchObject({ itemId: "call_x" })
              return t.respond(req.id, { decision: "accept" })
            }),
          )

          // turn/started (from initialize) then approval/echo (proof respond landed)
          const notifs = yield* t.notifications.pipe(Stream.take(2), Stream.runCollect)
          expect(notifs.map((n) => n.method)).toEqual(["turn/started", "approval/echo"])
          expect(notifs[1]?.params).toMatchObject({ decision: "accept" })
        }),
      ),
    15000,
  )
})
