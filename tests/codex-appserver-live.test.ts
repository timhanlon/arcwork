import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import { makeCodexAppServerDriver } from "../src/main/ingest/providers/codex-appserver/driver.js"

// Live end-to-end smoke against the real `codex app-server` binary. Opt-in
// (needs an authenticated codex + network), so it is skipped unless CODEX_LIVE=1.
// Run: `CODEX_LIVE=1 pnpm exec vitest run tests/codex-appserver-live.test.ts`.
const run = <A, E>(program: Effect.Effect<A, E, Scope.Scope>): Promise<A> =>
  Effect.runPromise(Effect.scoped(program))

describe("codex app-server driver (live)", () => {
  it.runIf(process.env.CODEX_LIVE === "1")(
    "drives a real codex turn and folds it into rows",
    () =>
      run(
        Effect.gen(function* () {
          const cwd = mkdtempSync(join(tmpdir(), "codex-live-"))
          const driver = yield* makeCodexAppServerDriver({
            cwd,
            sandbox: "read-only",
            approvalPolicy: "on-request",
          })
          // Auto-accept any approval so the turn can complete unattended.
          yield* SubscriptionRef.changes(driver.pendingApprovals).pipe(
            Stream.filter((list) => list.length > 0),
            Stream.runForEach((list) => driver.answerApproval(list[0]!.id, "accept")),
            Effect.forkScoped,
          )

          const result = yield* driver.runTurn(
            "Reply with exactly the word DONE and nothing else. Do not run any commands.",
          )
          expect(result.status).toBe("completed")
          const assistant = result.rows.messages.filter((m) => m.role === "assistant")
          expect(assistant.length).toBeGreaterThan(0)
          expect(result.rows.session.provider).toBe("codex")
        }),
      ),
    60000,
  )
})
