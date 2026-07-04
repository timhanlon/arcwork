import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Layer, ManagedRuntime, type Scope, Stream, SubscriptionRef } from "effect"
import { describe, expect, it } from "vitest"
import { IngestStore, IngestStoreLive } from "../src/main/ingest/db/store.js"
import { sqliteLayer } from "../src/main/ingest/db/sqlite.js"
import { launchCodexAppServerSession } from "../src/main/ingest/providers/codex-appserver/launch.js"

// Live end-to-end smoke against the real `codex app-server` binary, through the
// full pipeline: launch → driver → normalizer → shared store, across two turns
// (proving cumulative accumulation + store persistence). Opt-in (needs an
// authenticated codex + network), skipped unless CODEX_LIVE=1.
// Run: `CODEX_LIVE=1 pnpm exec vitest run tests/codex-appserver-live.test.ts`.
const run = <A, E>(program: Effect.Effect<A, E, IngestStore | Scope.Scope>): Promise<A> => {
  const runtime = ManagedRuntime.make(IngestStoreLive.pipe(Layer.provide(sqliteLayer(":memory:"))))
  return runtime.runPromise(Effect.scoped(program)).finally(() => runtime.dispose())
}

describe("codex app-server (live, full pipeline)", () => {
  it.runIf(process.env.CODEX_LIVE === "1")(
    "drives two real turns and persists cumulative rows to the store",
    () =>
      run(
        Effect.gen(function* () {
          const cwd = mkdtempSync(join(tmpdir(), "codex-live-"))
          const driver = yield* launchCodexAppServerSession(
            { launchCmd: "codex", args: ["app-server"] },
            { cwd, sandbox: "read-only", approvalPolicy: "on-request" },
          )
          // Auto-accept any approval so turns complete unattended.
          yield* SubscriptionRef.changes(driver.pendingApprovals).pipe(
            Stream.filter((list) => list.length > 0),
            Stream.runForEach((list) => driver.answerApproval(list[0]!.id, "accept")),
            Effect.forkScoped,
          )

          const t1 = yield* driver.runTurn("Reply with exactly the word ONE and nothing else. No commands.")
          expect(t1.status).toBe("completed")
          const usersAfter1 = t1.rows.messages.filter((m) => m.role === "user").length

          const t2 = yield* driver.runTurn("Reply with exactly the word TWO and nothing else. No commands.")
          expect(t2.status).toBe("completed")
          const usersAfter2 = t2.rows.messages.filter((m) => m.role === "user").length
          // Cumulative: the second turn's rows include the first turn's user message too.
          expect(usersAfter2).toBeGreaterThan(usersAfter1)

          const store = yield* IngestStore
          const stored = yield* store.getSession(t2.rows.session.id)
          expect(stored?.session.provider).toBe("codex")
          expect(stored?.messages.filter((m) => m.role === "assistant").length).toBeGreaterThanOrEqual(2)
        }),
      ),
    90000,
  )
})
