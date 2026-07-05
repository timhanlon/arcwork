import { Effect, Exit, Fiber, Scope, Stream } from "effect"
import { describe, expect, it } from "vitest"
import {
  AppServerTransportError,
  makeAppServerTransport,
} from "../src/main/ingest/providers/codex-appserver/transport.js"

// Answers `initialize`, then goes silent — a subsequent request never gets a
// response, so it stays pending until the scope is closed.
const SILENT_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
})
`

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

// Answers `initialize`, then exits the process on `die` — to prove a request made
// after the child is gone fails fast instead of hanging on a dead server.
const EXITING_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { ok: true } })
  else if (m.method === 'die') process.exit(0)
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

  it(
    "fails fast on a request made after the child has exited (no hang)",
    () =>
      run(
        Effect.gen(function* () {
          const t = yield* makeAppServerTransport({ command: process.execPath, args: ["-e", EXITING_PEER] })
          yield* t.request("initialize")

          // The in-flight `die` request fails when the process dies...
          const dieFailure = yield* Effect.flip(t.request("die"))
          expect(dieFailure).toBeInstanceOf(AppServerTransportError)

          // ...and a *fresh* request after the exit must also fail (closed), not
          // register a Deferred that no future exit event can ever resolve.
          const afterExit = yield* Effect.flip(t.request("turn/start"))
          expect(afterExit).toBeInstanceOf(AppServerTransportError)
        }),
      ),
    15000,
  )

  it(
    "fails an in-flight request when the scope is closed (intentional stop)",
    () =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Own scope so we can close it while a request is pending — modelling a
          // `stop` that closes the session scope. Closing interrupts the internal
          // drain fiber before the child dies, so only the scope finalizer can fail
          // the pending request.
          const scope = yield* Scope.make()
          const t = yield* makeAppServerTransport({
            command: process.execPath,
            args: ["-e", SILENT_PEER],
          }).pipe(Scope.provide(scope))
          yield* t.request("initialize")

          // A request the peer never answers, awaited in a fiber independent of the
          // transport scope (as `runTurn` is of the driver scope).
          const fiber = yield* Effect.forkDetach(Effect.flip(t.request("turn/start")))
          yield* Effect.sleep("50 millis") // let the pending Deferred register
          yield* Scope.close(scope, Exit.void)

          const failure = yield* Fiber.join(fiber)
          expect(failure).toBeInstanceOf(AppServerTransportError)
        }),
      ),
    15000,
  )
})
