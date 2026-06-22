import { EventEmitter } from "node:events"
import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { IngestStoreLive } from "../src/main/ingest/db/store.js"
import { ActivityEventServiceLive } from "../src/main/services/ActivityEventService.js"
import { ChatServiceLive } from "../src/main/services/ChatService.js"
import { LocalModelServiceLive } from "../src/main/services/LocalModelService.js"
import { TargetSessionManager } from "../src/main/services/TargetSessionManager.js"
import { ChatMessageService, ChatMessageServiceLive } from "../src/main/services/ChatMessageService.js"
import type { HookSignal } from "../src/main/hooks/signals.js"
import { toSignal } from "../src/main/hooks/signals.js"
import { arcId } from "../src/shared/ids.js"

const NOW = "2026-06-11T00:00:00.000Z"
const CHAT = "chat_1"
const TARGET = "target_1"

// The live-pending-permission flag never drives a PTY, so TargetSessionManager is
// only *acquired* by the layer — a stub keeps node-pty/socket setup out of the
// test while satisfying the dependency. Any method actually called is a bug.
const stubSessions = Layer.succeed(
  TargetSessionManager,
  TargetSessionManager.of({
    list: Effect.succeed([]),
    changes: Stream.empty,
    launch: () => Effect.die("TargetSessionManager.launch is unused in this test"),
    resume: () => Effect.die("TargetSessionManager.resume is unused in this test"),
    stop: () => Effect.succeed({ stopped: false }),
    bindNative: () => Effect.void,
    submit: () => Effect.succeed({ accepted: false }),
    write: () => Effect.void,
    resize: () => Effect.void,
    events: new EventEmitter(),
  }),
)

// One in-memory DB shared by every store (memoized by layer reference), the real
// ChatMessageService on top, and a stub session manager. Disposed per test.
const run = async <A, E>(
  program: Effect.Effect<A, E, ChatMessageService | ArcStore>,
): Promise<A> => {
  const sql = sqliteLayer(":memory:")
  const arc = ArcStoreLive.pipe(Layer.provide(sql))
  const deps = Layer.mergeAll(
    arc,
    IngestStoreLive.pipe(Layer.provide(sql)),
    ActivityEventServiceLive.pipe(Layer.provide(arc)),
    ChatServiceLive.pipe(Layer.provide(arc)),
    LocalModelServiceLive,
    stubSessions,
  )
  const runtime = ManagedRuntime.make(ChatMessageServiceLive.pipe(Layer.provideMerge(deps)))
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

// chat_messages / activity_events FK chats -> workspaces; the pending-event record
// on set/clear inserts an activity row, so the parents must exist.
const seed = Effect.gen(function* () {
  const db = yield* ArcStore
  yield* db.upsertWorkspace({ id: arcId("workspace", "ws_1"), path: "/tmp/ws", name: "ws", createdAt: NOW, lastOpenedAt: NOW })
  yield* db.insertChat({ id: arcId("chat", CHAT), workspaceId: arcId("workspace", "ws_1"), title: "c", createdAt: NOW })
  yield* db.upsertTargetSession({
    id: arcId("target", TARGET),
    chatId: arcId("chat", CHAT),
    provider: "claude",
    preset: null,
    cwd: "/tmp/ws",
    nativeSessionId: "sess_1",
    nativeTranscriptPath: null,
    state: "running",
    startedAt: NOW,
  })
})

const parseSignal = (body: Record<string, unknown>): HookSignal => {
  const result = toSignal(JSON.stringify(body))
  if (!result.ok) throw new Error(result.reason)
  return result.signal
}

// A Claude PermissionRequest for a non-question tool sets the live flag (it
// persists no chat row — mapClaude returns [] — so the flag is its only effect).
const permissionRequest = (observedAt = NOW): HookSignal =>
  parseSignal({
    declaredProvider: "claude",
    declaredEvent: "PermissionRequest",
    observedAt,
    hookInputSha256: "perm-bash",
    hookInput: { tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "tool_bash" },
    arc: { chatId: CHAT, targetSessionId: TARGET, targetProvider: "claude", hookSockPresent: true },
    arcTargetSessionId: TARGET,
    arcChatSessionId: CHAT,
  })

// A PostToolUse for the same tool is a resolution signal — it clears the flag.
const postToolUse = (observedAt: string): HookSignal =>
  parseSignal({
    declaredProvider: "claude",
    declaredEvent: "PostToolUse",
    observedAt,
    hookInputSha256: "post-bash",
    hookInput: { tool_name: "Bash" },
    arc: { chatId: CHAT, targetSessionId: TARGET, targetProvider: "claude", hookSockPresent: true },
    arcTargetSessionId: TARGET,
    arcChatSessionId: CHAT,
  })

// Cursor gates shell/MCP execution on approval. `beforeShellExecution` /
// `beforeMCPExecution` are the approval prompts; their `after*` counterparts fire
// once the command has run (approval answered). Unlike Claude, Cursor carries no
// `tool_name` on these, and resolves the provider off the payload shape
// (`hook_event_name` ∈ the cursor event set, plus `cursor_version`).
const cursorApprovalRequest = (
  event: "beforeShellExecution" | "beforeMCPExecution",
  observedAt = NOW,
): HookSignal =>
  parseSignal({
    declaredProvider: "cursor",
    declaredEvent: event,
    observedAt,
    hookInputSha256: `cursor-${event}`,
    hookInput: { hook_event_name: event, command: "rm -rf build", cursor_version: "2.5" },
    arc: { chatId: CHAT, targetSessionId: TARGET, targetProvider: "cursor", hookSockPresent: true },
    arcTargetSessionId: TARGET,
    arcChatSessionId: CHAT,
  })

const cursorApprovalResolution = (
  event: "afterShellExecution" | "afterMCPExecution" | "stop",
  observedAt: string,
): HookSignal =>
  parseSignal({
    declaredProvider: "cursor",
    declaredEvent: event,
    observedAt,
    hookInputSha256: `cursor-${event}`,
    hookInput: { hook_event_name: event, cursor_version: "2.5" },
    arc: { chatId: CHAT, targetSessionId: TARGET, targetProvider: "cursor", hookSockPresent: true },
    arcTargetSessionId: TARGET,
    arcChatSessionId: CHAT,
  })

describe("live pending permission flag (ChatMessageService)", () => {
  it("surfaces a permission-request signal in listPending without persisting a chat row", async () => {
    const result = await run(
      Effect.gen(function* () {
        yield* seed
        const db = yield* ArcStore
        const svc = yield* ChatMessageService
        const changed = yield* svc.ingestSignal(permissionRequest())
        const pending = yield* svc.listPending
        const rows = yield* db.loadChatMessagesForChat(CHAT)
        return { changed, pending, rowCount: rows.length }
      }),
    )

    expect(result.changed).toBe(1) // the live flag, not a persisted row
    expect(result.rowCount).toBe(0) // permission requests are never durable rows
    expect(result.pending).toEqual([{ chatId: CHAT, targetSessionId: TARGET, kind: "permission" }])
  })

  it("clears the live flag when a resolution signal arrives for the target", async () => {
    const pending = await run(
      Effect.gen(function* () {
        yield* seed
        const svc = yield* ChatMessageService
        yield* svc.ingestSignal(permissionRequest())
        const before = yield* svc.listPending
        yield* svc.ingestSignal(postToolUse("2026-06-11T00:00:01.000Z"))
        const after = yield* svc.listPending
        return { before: before.length, after: after.length }
      }),
    )

    expect(pending.before).toBe(1)
    expect(pending.after).toBe(0)
  })

  it("supersedePendingForTarget clears the live flag for a detached target", async () => {
    const pending = await run(
      Effect.gen(function* () {
        yield* seed
        const svc = yield* ChatMessageService
        yield* svc.ingestSignal(permissionRequest())
        const before = yield* svc.listPending
        const cleared = yield* svc.supersedePendingForTarget(arcId("target", TARGET))
        const after = yield* svc.listPending
        return { before: before.length, cleared, after: after.length }
      }),
    )

    expect(pending.before).toBe(1)
    expect(pending.cleared).toBe(1) // the in-memory entry counts toward the cleared total
    expect(pending.after).toBe(0)
  })

  it.each(["beforeShellExecution", "beforeMCPExecution"] as const)(
    "surfaces a Cursor %s approval as waiting_for_approval without persisting a row",
    async (event) => {
      const result = await run(
        Effect.gen(function* () {
          yield* seed
          const db = yield* ArcStore
          const svc = yield* ChatMessageService
          const changed = yield* svc.ingestSignal(cursorApprovalRequest(event))
          const pending = yield* svc.listPending
          const rows = yield* db.loadChatMessagesForChat(CHAT)
          return { changed, pending, rowCount: rows.length }
        }),
      )

      expect(result.changed).toBe(1) // the live flag, not a persisted row
      expect(result.rowCount).toBe(0) // shell/MCP approvals are never durable rows
      expect(result.pending).toEqual([{ chatId: CHAT, targetSessionId: TARGET, kind: "permission" }])
    },
  )

  it.each([
    ["afterShellExecution", "beforeShellExecution"],
    ["afterMCPExecution", "beforeMCPExecution"],
  ] as const)(
    "clears the Cursor approval flag when %s completes the run",
    async (after, before) => {
      const pending = await run(
        Effect.gen(function* () {
          yield* seed
          const svc = yield* ChatMessageService
          yield* svc.ingestSignal(cursorApprovalRequest(before))
          const beforeCount = (yield* svc.listPending).length
          yield* svc.ingestSignal(cursorApprovalResolution(after, "2026-06-11T00:00:01.000Z"))
          const afterCount = (yield* svc.listPending).length
          return { before: beforeCount, after: afterCount }
        }),
      )

      expect(pending.before).toBe(1)
      expect(pending.after).toBe(0)
    },
  )

  it("clears a stuck Cursor approval on the turn-ending stop (denial backstop)", async () => {
    // A denied shell command may emit no `afterShellExecution`. The turn's `stop`
    // must still clear the flag so waiting_for_approval cannot stick past the turn.
    const pending = await run(
      Effect.gen(function* () {
        yield* seed
        const svc = yield* ChatMessageService
        yield* svc.ingestSignal(cursorApprovalRequest("beforeShellExecution"))
        const before = (yield* svc.listPending).length
        yield* svc.ingestSignal(cursorApprovalResolution("stop", "2026-06-11T00:00:02.000Z"))
        const after = (yield* svc.listPending).length
        return { before, after }
      }),
    )

    expect(pending.before).toBe(1)
    expect(pending.after).toBe(0)
  })
})
