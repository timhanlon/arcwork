import { EventEmitter } from "node:events"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { IngestStoreLive } from "../src/main/ingest/db/store.js"
import { CodexDriverRegistryLive } from "../src/main/services/CodexDriverRegistry.js"
import { ChatServiceLive } from "../src/main/services/ChatService.js"
import { ProviderRegistry, ProviderRegistryLive } from "../src/main/services/ProviderRegistry.js"
import { RpcSessionManager, RpcSessionManagerLive } from "../src/main/services/RpcSessionManager.js"
import {
  SessionRuntimeRouter,
  SessionRuntimeRouterLive,
} from "../src/main/services/SessionRuntimeRouter.js"
import { TargetSessionManager } from "../src/main/services/TargetSessionManager.js"
import { WorkspaceServiceLive } from "../src/main/services/WorkspaceService.js"
import { arcId } from "../src/shared/ids.js"
import type { TargetSession } from "../src/shared/instance.js"

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

// A peer that handshakes and rejoins by id: thread/resume echoes its threadId
// back, so the resumed session comes up under the same native id.
const RESUME_PEER = `
const readline = require('node:readline')
const rl = readline.createInterface({ input: process.stdin })
const send = (o) => process.stdout.write(JSON.stringify(o) + '\\n')
rl.on('line', (line) => {
  if (!line.trim()) return
  const m = JSON.parse(line)
  if (m.method === 'initialize') send({ id: m.id, result: {} })
  else if (m.method === 'thread/resume') send({ id: m.id, result: { thread: { id: m.params.threadId } } })
})
`

// A ProviderRegistry whose codex app-server capability points at a scripted peer
// (not the real `codex` binary), so the router's rpc launch/resume is drivable.
const stubProviders = (args: ReadonlyArray<string>) =>
  Layer.succeed(
    ProviderRegistry,
    ProviderRegistry.of({
      list: Effect.succeed([]),
      get: (kind) =>
        Effect.succeed(
          kind === "codex"
            ? {
                kind: "codex",
                displayName: "Codex",
                detectCmd: "codex",
                concurrency: "per-worktree",
                appServer: { launchCmd: process.execPath, args },
              }
            : undefined,
        ),
    }),
  )

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
    release: () => Effect.void,
    bindNative: () => Effect.void,
    submit: () => Effect.succeed({ accepted: false }),
    write: () => Effect.void,
    resize: () => Effect.void,
    events: new EventEmitter(),
  }),
)

const NOW = "2026-06-11T00:00:00.000Z"

// A PTY manager stub that starts holding one id as a boot-restored *detached*
// shell and drops it on `release` — the exact state the real manager is in after
// a restart, so the router's ownership-transfer on rpc-resume is exercised.
const ptyHolding = (id: string) => {
  const held = new Set([id])
  const shell = (sid: string): TargetSession => ({
    _tag: "TargetSession",
    id: arcId("target", sid),
    provider: "codex",
    chatId: arcId("chat", "chat_res"),
    cwd: "/tmp/ws",
    attached: false,
    state: "unknown",
    startedAt: NOW,
  })
  return Layer.succeed(
    TargetSessionManager,
    TargetSessionManager.of({
      list: Effect.sync(() => [...held].map(shell)),
      changes: Stream.empty,
      launch: () => Effect.die("pty launch unused"),
      resume: () => Effect.die("pty resume unused"),
      stop: () => Effect.succeed({ stopped: false }),
      release: (sid) => Effect.sync(() => void held.delete(sid)),
      bindNative: () => Effect.void,
      submit: () => Effect.succeed({ accepted: false }),
      write: () => Effect.void,
      resize: () => Effect.void,
      events: new EventEmitter(),
    }),
  )
}

const run = <A, E>(
  program: Effect.Effect<A, E, SessionRuntimeRouter | RpcSessionManager | ArcStore>,
  providers: Layer.Layer<ProviderRegistry> = ProviderRegistryLive,
  pty: Layer.Layer<TargetSessionManager> = stubPty,
): Promise<A> => {
  const sql = sqliteLayer(":memory:")
  const arc = ArcStoreLive.pipe(Layer.provide(sql))
  const ingest = IngestStoreLive.pipe(Layer.provide(sql))
  const rpc = RpcSessionManagerLive.pipe(Layer.provide(CodexDriverRegistryLive), Layer.provide(ingest))
  const base = Layer.mergeAll(
    arc,
    rpc,
    providers,
    WorkspaceServiceLive.pipe(Layer.provide(arc)),
    ChatServiceLive.pipe(Layer.provide(arc)),
    pty,
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
            chatId: arcId("chat", "chat_1"),
            targetSessionId: arcId("target", "t1"),
            provider: "codex",
            startedAt: "2026-06-11T00:00:00.000Z",
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PEER],
          })

          expect(yield* router.ownsRpc("t1")).toBe(true)
          expect(yield* router.ownsRpc("unknown")).toBe(false)

          // The rpc session surfaces in the unified list (what `ListSessions`
          // returns) — the PTY manager never knew about it. Its thread id is bound.
          const listed = yield* router.sessions
          const t1 = listed.find((s) => s.id === "t1")
          expect(t1?.nativeSessionId).toBe("thr_router")

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

  it(
    "marks the persisted target row exited when an rpc session is stopped",
    () =>
      run(
        Effect.gen(function* () {
          const router = yield* SessionRuntimeRouter
          const rpc = yield* RpcSessionManager
          const db = yield* ArcStore

          // The FK chain + a running target row, as the router's rpc launch persists it.
          yield* db.upsertWorkspace({
            id: arcId("workspace", "ws_r"),
            path: "/tmp/ws",
            name: "ws",
            createdAt: NOW,
            lastOpenedAt: NOW,
          })
          yield* db.insertChat({
            id: arcId("chat", "chat_r"),
            workspaceId: arcId("workspace", "ws_r"),
            title: "c",
            createdAt: NOW,
          })
          yield* db.upsertTargetSession({
            id: arcId("target", "ts1"),
            chatId: arcId("chat", "chat_r"),
            provider: "codex",
            preset: null,
            cwd: "/tmp/ws",
            nativeSessionId: "thr_ts1",
            nativeTranscriptPath: null,
            state: "running",
            startedAt: NOW,
          })
          // Bring the driver live under the manager so the router owns + can stop it.
          yield* rpc.launch({
            chatId: arcId("chat", "chat_r"),
            targetSessionId: arcId("target", "ts1"),
            provider: "codex",
            startedAt: NOW,
            cwd: process.cwd(),
            command: process.execPath,
            args: ["-e", PEER],
          })

          expect(yield* router.stop({ sessionId: "ts1" })).toEqual({ stopped: true })

          // The durable row is now exited — a restart won't resurrect it as a stale
          // (non-attached) PTY target.
          const rows = yield* db.loadTargetSessions
          expect(rows.find((r) => r.id === "ts1")?.state).toBe("exited")
        }),
      ),
    15000,
  )

  it(
    "resumes into the rpc runtime by rejoining the thread by its native id",
    () =>
      run(
        Effect.gen(function* () {
          const router = yield* SessionRuntimeRouter
          const db = yield* ArcStore

          // A previously-launched (now exited) app-server codex session on disk.
          yield* db.upsertWorkspace({
            id: arcId("workspace", "ws_res"),
            path: "/tmp/ws",
            name: "ws",
            createdAt: NOW,
            lastOpenedAt: NOW,
          })
          yield* db.insertChat({
            id: arcId("chat", "chat_res"),
            workspaceId: arcId("workspace", "ws_res"),
            title: "c",
            createdAt: NOW,
          })
          yield* db.upsertTargetSession({
            id: arcId("target", "tsR"),
            chatId: arcId("chat", "chat_res"),
            provider: "codex",
            preset: null,
            // Real cwd: the driver spawns the peer here (the row's cwd).
            cwd: process.cwd(),
            nativeSessionId: "thr_old",
            nativeTranscriptPath: null,
            state: "exited",
            startedAt: NOW,
          })

          const session = yield* router.resume({ sessionId: "tsR", runtime: "rpc" })

          // Rejoined under the same thread id (thread/resume, not a fresh start)...
          expect(session.nativeSessionId).toBe("thr_old")
          expect(session.id).toBe("tsR")
          // ...and the durable row is running again + owned by the rpc manager.
          const rows = yield* db.loadTargetSessions
          expect(rows.find((r) => r.id === "tsR")?.state).toBe("running")
          expect(yield* router.ownsRpc("tsR")).toBe(true)

          // Ownership transferred: the PTY manager released its boot-restored shell,
          // so the unified list carries the id exactly once (not once per manager).
          const unified = yield* router.sessions
          expect(unified.filter((s) => s.id === "tsR")).toHaveLength(1)
          expect(unified.find((s) => s.id === "tsR")?.attached).toBe(true)
        }),
        stubProviders(["-e", RESUME_PEER]),
        // A PTY manager that holds "tsR" as a boot-restored detached shell (as the
        // real one does after restart) and honors `release` — so the test proves the
        // resume evicts it rather than leaving a duplicate.
        ptyHolding("tsR"),
      ),
    15000,
  )
})
