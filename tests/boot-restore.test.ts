import { Effect, Layer, ManagedRuntime } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { EventEmitter } from "node:events"
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest"
import { arcId } from "../src/shared/ids.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { HookSignalServer } from "../src/main/services/HookSignalServer.js"
import { installProviderHooks } from "../src/main/hooks/install.js"
import { restorePersistedSessions } from "../src/main/services/target-session/boot-restore.js"

// boot-restore rebuilds the live session map from persisted rows on startup and
// re-arms hook sockets for still-running targets. Split out of the manager so
// the row→session mapping (exited stays exited, everything else → "unknown") and
// the per-(cwd,provider) hook-arm dedup are testable against a real in-memory
// store, with the socket/file side effects stubbed.

const installCalls: Array<{ cwd: string; provider: string }> = []
vi.mock("../src/main/hooks/install.js", () => ({
  installProviderHooks: vi.fn((cwd: string, provider: string) => {
    installCalls.push({ cwd, provider })
    return Effect.succeed({ installed: true })
  }),
}))

const ensureListeningCalls: Array<string> = []
const HookStub = Layer.succeed(HookSignalServer, {
  ensureListening: (repoRoot: string) =>
    Effect.sync(() => {
      ensureListeningCalls.push(repoRoot)
      return repoRoot
    }),
  events: new EventEmitter(),
} as never)

const WS = arcId("workspace", "workspace_boot")
const CHAT = arcId("chat", "chat_boot")
const StoreLive = ArcStoreLive.pipe(Layer.provide(sqliteLayer(":memory:")))
const TestLayer = Layer.mergeAll(StoreLive, HookStub)

const seed = Effect.gen(function* () {
  const store = yield* ArcStore
  yield* store.upsertWorkspace({
    id: WS,
    path: "/repoA",
    name: "A",
    createdAt: "2026-01-01T00:00:00.000Z",
    lastOpenedAt: "2026-01-01T00:00:00.000Z",
  })
  yield* store.insertChat({ id: CHAT, workspaceId: WS, title: "boot", createdAt: "2026-01-01T00:00:00.000Z" })
  const row = (id: string, cwd: string, provider: string, state: string) =>
    store.upsertTargetSession({
      id: arcId("target", id),
      chatId: CHAT,
      provider,
      origin: "manual",
      preset: null,
      cwd,
      nativeSessionId: null,
      nativeTranscriptPath: null,
      state,
      startedAt: "2026-01-01T00:00:00.000Z",
    })
  // Two running claude sessions in /repoA (a duplicate cwd+provider pair) plus
  // one exited codex session in /repoB.
  yield* row("target_a1", "/repoA", "claude", "running")
  yield* row("target_a2", "/repoA", "claude", "starting")
  yield* row("target_b", "/repoB", "codex", "exited")
})

describe("restorePersistedSessions", () => {
  let runtime: ManagedRuntime.ManagedRuntime<ArcStore | HookSignalServer, SqlError>

  beforeAll(async () => {
    runtime = ManagedRuntime.make(TestLayer)
    await runtime.runPromise(seed)
  })
  afterAll(async () => {
    await runtime.dispose()
  })

  it("maps every persisted row, forcing non-exited state to unknown", async () => {
    const map = await runtime.runPromise(restorePersistedSessions)

    expect(map.size).toBe(3)
    expect(map.get(arcId("target", "target_a1"))?.state).toBe("unknown")
    expect(map.get(arcId("target", "target_a2"))?.state).toBe("unknown")
    expect(map.get(arcId("target", "target_b"))?.state).toBe("exited")
    expect(map.get(arcId("target", "target_a1"))?.attached).toBe(false)
  })

  it("re-arms hooks once per (cwd, provider) for non-exited targets only", async () => {
    ensureListeningCalls.length = 0
    installCalls.length = 0

    await runtime.runPromise(restorePersistedSessions)

    // /repoA armed once despite two running sessions; /repoB skipped (exited).
    expect(ensureListeningCalls).toEqual(["/repoA"])
    expect(installCalls).toEqual([{ cwd: "/repoA", provider: "claude" }])
  })
})
