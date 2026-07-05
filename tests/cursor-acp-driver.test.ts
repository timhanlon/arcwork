import { Effect, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import { AppServerDriverError } from "../src/main/ingest/providers/app-server-driver.js"
import { makeCursorAcpDriver } from "../src/main/ingest/providers/cursor-acp/driver.js"

// A scripted ACP peer (stands in for `cursor-agent acp`, no auth / network). It
// handshakes, then on `session/prompt` streams an ignored info/commands update, a
// pending execute `tool_call`, and a `session/request_permission` (id 0 — numeric
// zero, the real cursor id, to prove routing). Once the client answers request 0
// it completes the tool (rawOutput), emits the assistant reply, and resolves the
// prompt with `{ stopReason: "end_turn" }` — that response is the turn signal.
const PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const upd = (update) => send({ method: 'session/update', params: { sessionId: 'sess_test', update } })
let promptId = null
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true } } })
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'sess_test' } })
  else if (m.method === 'session/prompt') {
    promptId = m.id
    upd({ sessionUpdate: 'available_commands_update', availableCommands: [] })
    upd({ sessionUpdate: 'session_info_update', title: 'Echo' })
    upd({ sessionUpdate: 'tool_call', toolCallId: 'tool_1', title: '\\\`echo hi\\\`', kind: 'execute', status: 'pending', rawInput: { command: 'echo hi' } })
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'tool_1', status: 'in_progress' })
    send({ id: 0, method: 'session/request_permission', params: { sessionId: 'sess_test', toolCall: { toolCallId: 'tool_1', title: '\\\`echo hi\\\`', kind: 'execute', status: 'pending' }, options: [{ optionId: 'allow-once', name: 'Allow once', kind: 'allow_once' }, { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }] } })
  } else if (m.method == null && m.id === 0) {
    upd({ sessionUpdate: 'tool_call_update', toolCallId: 'tool_1', status: 'completed', rawOutput: { exitCode: 0, stdout: 'hi\\n', stderr: '' } })
    upd({ sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'done' } })
    send({ id: promptId, result: { stopReason: 'end_turn' } })
  }
})
`

// Resume peer: `session/load` replays the prior transcript as session/update
// notifications BEFORE its reply (the observed cursor behavior), then a new turn
// streams only 'new'. Proves the driver drains replay and accumulates only the
// new turn.
const RESUME_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
const upd = (sid, update) => send({ method: 'session/update', params: { sessionId: sid, update } })
let promptId = null
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: { agentCapabilities: { loadSession: true } } })
  else if (m.method === 'session/load') {
    upd(m.params.sessionId, { sessionUpdate: 'user_message_chunk', content: { type: 'text', text: 'OLD PROMPT' } })
    upd(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'OLD REPLY' } })
    send({ id: m.id, result: { modes: {}, models: {} } })
  } else if (m.method === 'session/prompt') {
    promptId = m.id
    upd(m.params.sessionId, { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'new' } })
    send({ id: promptId, result: { stopReason: 'end_turn' } })
  }
})
`

// Handshakes, then exits the process on `session/prompt` before responding — the
// mid-turn crash that must fail runTurn (via the failed prompt request), not hang.
const MIDTURN_EXIT_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'session/new') send({ id: m.id, result: { sessionId: 'sess_x' } })
  else if (m.method === 'session/prompt') process.exit(0)
})
`

const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(program))

describe("cursor ACP driver", () => {
  it(
    "handshakes, records + answers a permission (id 0), and folds the turn into rows",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* makeCursorAcpDriver({
            cwd: process.cwd(),
            model: "cursor-default",
            command: process.execPath,
            args: ["-e", PEER],
          })
          expect(driver.threadId).toBe("sess_test")

          // Answer the permission with the first option's id (as the renderer does).
          yield* SubscriptionRef.changes(driver.pendingApprovals).pipe(
            Stream.filter((list) => list.length > 0),
            Stream.take(1),
            Stream.runForEach((list) => {
              const approval = list[0]!
              expect(approval.id).toBe(0) // numeric zero routed correctly
              expect(approval.itemId).toBe("tool_1")
              expect(approval.command).toBe("`echo hi`")
              // Options are surfaced verbatim as { optionId, name, kind } objects.
              expect((approval.availableDecisions[0] as { optionId: string }).optionId).toBe("allow-once")
              return driver.answerApproval(approval.id, "allow-once")
            }),
            Effect.forkScoped,
          )

          const result = yield* driver.runTurn("Run echo hi then say done.")
          expect(result.status).toBe("completed")
          // The user turn is synthesized from the prompt text (ACP never echoes it).
          expect(result.rows.messages.map((m) => m.role)).toEqual(["user", "assistant"])
          expect(result.rows.messages[0]?.text).toContain("echo hi")
          expect(result.rows.messages.find((m) => m.role === "assistant")?.text).toBe("done")

          const tool = result.rows.toolCalls.find((t) => t.nativeToolId === "tool_1")
          expect(tool?.name).toBe("Shell")
          expect(tool?.outputText).toBe("hi\n")
          expect(result.rows.session.nativeSessionId).toBe("sess_test")

          // Answering cleared the pending signal.
          expect(yield* SubscriptionRef.get(driver.pendingApprovals)).toHaveLength(0)
        }),
      ),
    15000,
  )

  it(
    "rejoins by id via session/load and drains replay (new turn only)",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* makeCursorAcpDriver({
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", RESUME_PEER],
            resumeThreadId: "sess_old",
          })
          expect(driver.threadId).toBe("sess_old")

          const result = yield* driver.runTurn("hi")
          // The replayed prior transcript ('OLD PROMPT' / 'OLD REPLY') is discarded;
          // only the synthesized user turn + the new assistant reply remain.
          expect(result.rows.messages.map((m) => m.role)).toEqual(["user", "assistant"])
          expect(result.rows.messages.find((m) => m.role === "assistant")?.text).toBe("new")
          expect(result.rows.messages.some((m) => (m.text ?? "").includes("OLD"))).toBe(false)
        }),
      ),
    15000,
  )

  it(
    "fails the turn (does not hang) when the process exits mid-turn",
    () =>
      run(
        Effect.gen(function* () {
          const driver = yield* makeCursorAcpDriver({
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", MIDTURN_EXIT_PEER],
          })
          const failure = yield* Effect.flip(driver.runTurn("hi"))
          expect(failure).toBeInstanceOf(AppServerDriverError)
        }),
      ),
    15000,
  )
})
