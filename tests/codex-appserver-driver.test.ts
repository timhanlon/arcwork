import { Effect, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import {
  CodexDriverError,
  makeCodexAppServerDriver,
} from "../src/main/ingest/providers/codex-appserver/driver.js"

// A scripted thread/turn peer (stands in for `codex app-server`). It completes
// the handshake, then on `turn/start` streams a user item and asks for approval
// before "running" the command; once the client answers request 501 it streams
// the commandExecution + agentMessage + token usage, completes the turn, and
// confirms the approval resolved.
const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { userAgent: 'peer' } })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_test' } } })
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 'turn_1', status: 'inProgress' } } })
    send({ method: 'turn/started', params: { turn: { id: 'turn_1' } } })
    send({ method: 'item/completed', params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] } } })
    send({ id: 501, method: 'item/commandExecution/requestApproval', params: { itemId: 'call_1', command: 'echo hi', availableDecisions: ['accept', 'cancel'] } })
  } else if (m.method == null && m.id === 501) {
    send({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'call_1', command: 'echo hi', status: 'completed', exitCode: 0, aggregatedOutput: 'hi\\n' } } })
    send({ method: 'item/completed', params: { item: { type: 'agentMessage', id: 'a1', text: 'done', phase: 'final_answer' } } })
    send({ method: 'thread/tokenUsage/updated', params: { tokenUsage: { last: { inputTokens: 100, outputTokens: 5 }, modelContextWindow: 200000 } } })
    send({ method: 'turn/completed', params: { turn: { id: 'turn_1', status: 'completed' } } })
    send({ method: 'serverRequest/resolved', params: { requestId: 501 } })
  }
})
`

// Echoes the resumed threadId back from thread/resume (and a distinct id from
// thread/start), so the test can prove the driver rejoined by id rather than
// starting a fresh thread.
const RESUME_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_fresh' } } })
  else if (m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.params.threadId } } })
})
`

// Acks turn/start (so runTurn gets past the request and blocks on the outcome
// queue), then exits before turn/completed — the mid-turn crash that must fail
// runTurn fast rather than hang it on a completion that never arrives.
const MIDTURN_EXIT_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/start') send({ id: m.id, result: { thread: { id: 'thr_x' } } })
  else if (m.method === 'turn/start') {
    send({ id: m.id, result: { turn: { id: 't1', status: 'inProgress' } } })
    process.exit(0)
  }
})
`

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(program))

describe("codex app-server driver", () => {
  it(
    "handshakes, records + answers an approval, and folds the turn into rows",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* makeCodexAppServerDriver({
            cwd: process.cwd(),
            model: "gpt-5.4",
            sandbox: "read-only",
            approvalPolicy: "untrusted",
            command: process.execPath,
            args: ["-e", PEER],
          })
          expect(driver.threadId).toBe("thr_test")

          // Answer approvals as they surface (mirrors the UI answering the signal).
          yield* SubscriptionRef.changes(driver.pendingApprovals).pipe(
            Stream.filter((list) => list.length > 0),
            Stream.take(1),
            Stream.runForEach((list) => {
              expect(list[0]?.itemId).toBe("call_1")
              expect(list[0]?.availableDecisions).toContain("accept")
              return driver.answerApproval(list[0]!.id, "accept")
            }),
            Effect.forkScoped,
          )

          const result = yield* driver.runTurn("hi")
          expect(result.status).toBe("completed")
          expect(result.rows.messages.map((m) => m.role)).toEqual(["user", "assistant"])
          expect(result.rows.messages.find((m) => m.role === "assistant")?.text).toBe("done")

          const tool = result.rows.toolCalls.find((t) => t.nativeToolId === "call_1")
          expect(tool?.name).toBe("shell")
          expect(tool?.outputText).toBe("hi\n")

          expect(result.rows.usageEvents[0]?.inputTokens).toBe(100)
          expect(result.rows.session.nativeSessionId).toBe("thr_test")

          // serverRequest/resolved cleared the pending signal.
          const remaining = yield* SubscriptionRef.get(driver.pendingApprovals)
          expect(remaining).toHaveLength(0)
        }),
      ),
    15000,
  )

  it(
    "rejoins an existing thread by id via thread/resume",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* makeCodexAppServerDriver({
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", RESUME_PEER],
            resumeThreadId: "thr_resumed",
          })
          // The peer echoes thread/resume's threadId (and would answer thread/start
          // with 'thr_fresh'), so this proves the resume branch fired.
          expect(driver.threadId).toBe("thr_resumed")
        }),
      ),
    15000,
  )

  it(
    "fails the turn (does not hang) when the process exits mid-turn",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* makeCodexAppServerDriver({
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", MIDTURN_EXIT_PEER],
          })
          // The peer acks turn/start then exits before turn/completed. runTurn must
          // resolve to a failure (via the aborted signal), not block on the queue.
          const failure = yield* Effect.flip(driver.runTurn("hi"))
          expect(failure).toBeInstanceOf(CodexDriverError)
        }),
      ),
    15000,
  )
})
