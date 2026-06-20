import { Effect, Layer } from "effect"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { hookSignalToActivityDrafts } from "../hooks/agent-event.js"
import { hookSignalToChatMessageDrafts } from "../hooks/chat-message.js"
import { toSignal } from "../hooks/signals.js"
import { ArcStore, ArcStoreLive } from "../db/store.js"
import { sqliteLayer } from "../db/sqlite.js"
import { RawHookSignalService, RawHookSignalServiceLive } from "../services/RawHookSignalService.js"
import { ingestHookSignal } from "../services/HookSignalIngestion.js"

const assert = (condition: unknown, message: string): void => {
  if (!condition) throw new Error(message)
}

const parseSignal = () => {
  const result = toSignal(JSON.stringify({
    schemaVersion: 1,
    helperVersion: 1,
    declaredProvider: "cursor",
    declaredEvent: "preToolUse",
    observedAt: "2026-06-04T12:00:00.000Z",
    hookInputSha256: "cursor-preToolUse-ask",
    hookInputParseOk: true,
    hookInput: {
      conversation_id: "conv-ask",
      hook_event_name: "preToolUse",
      tool_name: "AskQuestion",
      tool_input: { questions: [{ prompt: "Pick one", options: ["a", "b"] }] },
      cursor_version: "1.0.0",
    },
    arc: {
      chatId: "chat_01",
      targetSessionId: "target_01",
      targetProvider: "cursor",
      hookSockPresent: true,
    },
    arcTargetSessionId: "target_01",
    arcChatSessionId: "chat_01",
    arcTargetProvider: "cursor",
  }))
  if (!result.ok) throw new Error(result.reason)
  return result.signal
}

const main = async (): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "arcwork-smoke-"))
  try {
    const store = ArcStoreLive.pipe(Layer.provide(sqliteLayer(join(dir, "arc.sqlite"))))
    const layer = Layer.mergeAll(store, RawHookSignalServiceLive.pipe(Layer.provide(store)))

    await Effect.runPromise(Effect.gen(function* () {
      const raw = yield* RawHookSignalService
      const db = yield* ArcStore
      const signal = parseSignal()

      assert(hookSignalToActivityDrafts(signal).length === 0, "expected zero activity drafts")
      const chatDrafts = hookSignalToChatMessageDrafts(signal)
      assert(chatDrafts.length === 1, "expected one request chat draft")
      assert(chatDrafts[0]?.role === "request", "expected request chat draft")

      const inserted = yield* raw.ingestSignal(signal)
      assert(inserted === true, "expected first raw insert to succeed")

      const duplicate = yield* raw.ingestSignal(signal)
      assert(duplicate === false, "expected duplicate raw insert to dedupe")

      yield* ingestHookSignal({
        raw,
        activity: {
          ingestSignal: () =>
            Effect.gen(function* () {
              const rows = yield* db.loadRawHookSignalsForTarget("target_01")
              assert(rows.length === 1, "activity projection ran before raw row was durable")
              return 0
            }).pipe(Effect.orElseSucceed(() => 0)),
        },
        chat: { ingestSignal: () => Effect.succeed(0) },
      }, signal)

      const rows = yield* db.loadRawHookSignalsForTarget("target_01")
      assert(rows.length === 1, `expected one raw hook row, got ${rows.length}`)
      assert(rows[0]?.declaredEvent === "preToolUse", "expected preToolUse row")
      assert(rows[0]?.resolvedProvider === "cursor", "expected cursor provider")

      const payload = JSON.parse(rows[0]!.payloadJson) as { hookInput?: Record<string, unknown> }
      assert(payload.hookInput?.["tool_name"] === "AskQuestion", "expected unredacted tool name")
      assert(!JSON.stringify(payload).includes("[REDACTED]"), "raw payload should not be redacted")
    }).pipe(Effect.provide(layer)))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

main().then(
  () => {
    console.log("raw hook signal Electron smoke passed")
    process.exit(0)
  },
  (error: unknown) => {
    console.error(error)
    process.exit(1)
  },
)
