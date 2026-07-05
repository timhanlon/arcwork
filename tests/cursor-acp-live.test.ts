import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import { IngestStore, IngestStoreLive } from "../src/main/ingest/db/store.js"
import { sqliteLayer } from "../src/main/ingest/db/sqlite.js"
import { launchCursorAcpSession } from "../src/main/ingest/providers/cursor-acp/launch.js"

// Live end-to-end smoke against the real `cursor-agent acp` binary, through the
// full pipeline: launch → driver → normalizer → shared store. Runs one turn that
// executes a shell command, auto-answering the permission with `allow-once` via
// the driver's `answerApproval`. Opt-in (needs an authenticated cursor-agent),
// skipped unless CURSOR_LIVE=1.
// Run: `CURSOR_LIVE=1 pnpm exec vitest run tests/cursor-acp-live.test.ts`.
const run = <A, E>(program: Effect.Effect<A, E, IngestStore | Scope.Scope>): Promise<A> => {
  const runtime = ManagedRuntime.make(IngestStoreLive.pipe(Layer.provide(sqliteLayer(":memory:"))))
  return runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose())
}

describe("cursor ACP (live, full pipeline)", () => {
  it.runIf(process.env.CURSOR_LIVE === "1")(
    "drives a real turn that runs a shell command and persists rows",
    () =>
      run(
        Effect.gen(function* () {
          const cwd = mkdtempSync(join(tmpdir(), "cursor-acp-live-"))
          const driver = yield* launchCursorAcpSession(
            { launchCmd: "cursor-agent", args: ["acp"], protocol: "acp" },
            { cwd },
          )

          // Auto-answer any permission with its `allow_once` option (else the first).
          yield* SubscriptionRef.changes(driver.pendingApprovals).pipe(
            Stream.filter((list) => list.length > 0),
            Stream.runForEach((list) =>
              Effect.forEach(list, (approval) => {
                const options = approval.availableDecisions as ReadonlyArray<{
                  readonly optionId: string
                  readonly kind?: string
                }>
                const chosen = options.find((o) => o.kind === "allow_once") ?? options[0]
                return chosen ? driver.answerApproval(approval.id, chosen.optionId) : Effect.void
              }),
            ),
            Effect.forkScoped,
          )

          const turn = yield* driver.runTurn(
            "Run exactly `echo hello-acp` in the shell using a command, then reply with the single word DONE.",
          )

          const commandTool = turn.rows.toolCalls.find((t) =>
            (t.inputJson ?? "").includes("echo hello-acp"),
          )
          const assistant = turn.rows.messages.filter((m) => m.role === "assistant")

          // Print the rows for the report.
          writeFileSync(
            join(tmpdir(), "cursor-acp-live-rows.json"),
            JSON.stringify(
              {
                status: turn.status,
                nativeSessionId: turn.rows.session.nativeSessionId,
                provider: turn.rows.session.provider,
                messages: turn.rows.messages.map((m) => ({ role: m.role, text: m.text })),
                toolCalls: turn.rows.toolCalls.map((t) => ({
                  name: t.name,
                  input: t.inputJson,
                  output: t.outputText,
                })),
              },
              null,
              2,
            ),
          )

          expect(turn.status).toBe("completed")
          expect(commandTool).toBeDefined()
          expect(commandTool?.name).toBe("Shell")
          expect(commandTool?.outputText ?? "").toContain("hello-acp")
          expect(assistant.length).toBeGreaterThanOrEqual(1)

          // The turn landed in the shared store, indistinguishable from a scrape.
          const store = yield* IngestStore
          const stored = yield* store.getSession(turn.rows.session.id)
          expect(stored?.session.provider).toBe("cursor")
        }),
      ),
    90000,
  )
})
