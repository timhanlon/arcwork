import { Effect, Option, Queue, type Scope, Stream, SubscriptionRef } from "effect"
import {
  type AppServerDriver,
  AppServerDriverError,
  type PendingApproval,
  type TurnResult,
} from "../app-server-driver.js"
import { obj, str } from "../../extract/json.js"
import { type AcpItem, normalizeAcpSession } from "./normalize.js"
import {
  decodePermissionParams,
  decodePromptResult,
  decodeSessionNew,
  decodeSessionUpdate,
  type RequestPermissionParams,
} from "./protocol.js"
import {
  type AppServerTransport,
  type AppServerTransportError,
  type JsonRpcNotification,
  makeAppServerTransport,
} from "../codex-appserver/transport.js"

/**
 * The Cursor ACP driver: the one place that knows the ACP dialect. It owns a live
 * `cursor-agent acp` process (via the generic transport), runs the
 * `initialize → session/new` (or `session/load` for resume) handshake, folds each
 * turn's `session/update` notification stream into the shared `ExtractedRows`
 * (via {@link normalizeAcpSession}), and turns `session/request_permission`
 * server requests into the same {@link PendingApproval} signal the codex driver
 * uses — so both dialects present one {@link AppServerDriver} to the seam.
 *
 * ACP differs from codex in two ways the fold handles here: the turn completion
 * signal is the `session/prompt` *response* (`{ stopReason }`), not a notification,
 * and the user turn is never echoed back as an update — so `runTurn` synthesizes
 * the user message from the prompt text and drives the notification fold itself
 * (owning the item list for the turn's duration), rather than a standing fold
 * fiber offering completed turns.
 */
export interface CursorAcpDriverOptions {
  readonly cwd: string
  readonly model?: string
  /** Defaults to `cursor-agent`. */
  readonly command?: string
  /** Defaults to `["acp"]`. */
  readonly args?: ReadonlyArray<string>
  readonly env?: Record<string, string>
  /** Rejoin an existing session by id (`session/load`) instead of starting fresh (`session/new`). */
  readonly resumeThreadId?: string
}

const wrap =
  (message: string) =>
  <A, R>(effect: Effect.Effect<A, AppServerTransportError, R>): Effect.Effect<A, AppServerDriverError, R> =>
    effect.pipe(Effect.mapError((cause) => new AppServerDriverError({ message, cause })))

/** Map an ACP `stopReason` to a turn status. `end_turn` is the clean completion. */
const statusFromStopReason = (stopReason: string | undefined): string => {
  switch (stopReason) {
    case "end_turn":
      return "completed"
    case "cancelled":
      return "interrupted"
    default:
      return stopReason ?? "unknown"
  }
}

export const makeCursorAcpDriver = (
  options: CursorAcpDriverOptions,
): Effect.Effect<AppServerDriver, AppServerDriverError, Scope.Scope> =>
  Effect.gen(function* () {
    const transport: AppServerTransport = yield* makeAppServerTransport({
      command: options.command ?? "cursor-agent",
      args: options.args ?? ["acp"],
      cwd: options.cwd,
      env: options.env,
    }).pipe(wrap("failed to spawn cursor-agent acp"))

    // Handshake: initialize → session/new (fresh) or session/load (rejoin by id).
    // `session/new` returns the sessionId; `session/load` takes it as input and
    // returns only modes/models, so the resumed id is the one we passed in.
    yield* transport
      .request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: false, writeTextFile: false } },
      })
      .pipe(wrap("initialize failed"))

    let sessionId: string
    if (options.resumeThreadId) {
      yield* transport
        .request("session/load", { sessionId: options.resumeThreadId, cwd: options.cwd, mcpServers: [] })
        .pipe(wrap("session/load failed"))
      sessionId = options.resumeThreadId
    } else {
      const created = yield* transport
        .request("session/new", { cwd: options.cwd, mcpServers: [] })
        .pipe(wrap("session/new failed"))
      const decoded = decodeSessionNew(created)
      if (Option.isNone(decoded)) {
        return yield* Effect.fail(
          new AppServerDriverError({ message: "session/new returned no sessionId", cause: created }),
        )
      }
      sessionId = decoded.value.sessionId
    }

    // Discard any `session/load` replay: cursor replays the prior transcript as
    // `session/update` notifications *before* the load response resolves, so by
    // now they are all buffered on the transport's notifications queue. Draining
    // it here (race-free — the transport routes stdout in order, so every replay
    // frame was offered before the response we already awaited) keeps `runTurn`
    // accumulating only new turns, matching the codex resume semantics (the prior
    // rows are already persisted). `session/new` buffers nothing, so this no-ops.
    yield* Queue.clear(transport.notifications)

    const pendingApprovals = yield* SubscriptionRef.make<ReadonlyArray<PendingApproval>>([])

    // Session-cumulative item list + the folder that mutates it. `pendingText`
    // buffers `agent_message_chunk` deltas; it is flushed as one assistant message
    // when a `tool_call` arrives or the turn completes. `toolIndex` upserts a tool
    // by `toolCallId` so a later `tool_call_update` merges onto the same item,
    // preserving order. Only ever touched by the single active turn's fold (below)
    // + the between-turns drain, so no locking is needed.
    const items: Array<AcpItem> = []
    const toolIndex = new Map<string, number>()
    let pendingText: Array<string> = []

    const flushText = (): void => {
      if (pendingText.length === 0) return
      items.push({ kind: "message", role: "assistant", text: pendingText.join("") })
      pendingText = []
    }

    const readExecOutput = (rawOutput: unknown): { exitCode: number | null; output: string | null } => {
      const o = obj(rawOutput)
      if (!o) return { exitCode: null, output: rawOutput != null ? JSON.stringify(rawOutput) : null }
      const exitCode = typeof o["exitCode"] === "number" ? o["exitCode"] : null
      const stdout = str(o["stdout"]) ?? ""
      const stderr = str(o["stderr"]) ?? ""
      const hasStd = "stdout" in o || "stderr" in o
      const output = hasStd ? stdout + stderr : JSON.stringify(rawOutput)
      return { exitCode, output }
    }

    const foldNotification = (notification: JsonRpcNotification): void => {
      const decoded = decodeSessionUpdate(notification.params)
      if (Option.isNone(decoded)) return // unknown variant (info/commands/replay-user) → skip
      const update = decoded.value.update
      switch (update.sessionUpdate) {
        case "agent_message_chunk": {
          const text = update.content?.text
          if (text) pendingText.push(text)
          break
        }
        case "tool_call": {
          // A tool boundary flushes the assistant text accumulated before it, so
          // the message lands on its own ordinal ahead of the tool.
          flushText()
          const input = obj(update.rawInput) ?? null
          items.push({
            kind: "tool",
            toolCallId: update.toolCallId,
            title: update.title ?? null,
            toolKind: update.kind ?? null,
            command: str(input?.["command"]) ?? null,
            exitCode: null,
            output: null,
            input,
          })
          toolIndex.set(update.toolCallId, items.length - 1)
          break
        }
        case "tool_call_update": {
          const idx = toolIndex.get(update.toolCallId)
          const existing = idx != null ? items[idx] : undefined
          const merged = update.rawOutput !== undefined ? readExecOutput(update.rawOutput) : null
          if (existing && existing.kind === "tool") {
            items[idx!] = {
              ...existing,
              exitCode: merged?.exitCode ?? existing.exitCode,
              output: merged?.output ?? existing.output,
              command: existing.command ?? str(obj(update.rawInput)?.["command"]) ?? null,
            }
          } else {
            // An update with no preceding tool_call — record it so the output is
            // not lost, keyed for any further updates.
            const input = obj(update.rawInput) ?? null
            items.push({
              kind: "tool",
              toolCallId: update.toolCallId,
              title: update.title ?? null,
              toolKind: update.kind ?? null,
              command: str(input?.["command"]) ?? null,
              exitCode: merged?.exitCode ?? null,
              output: merged?.output ?? null,
              input,
            })
            toolIndex.set(update.toolCallId, items.length - 1)
          }
          break
        }
      }
    }

    // Permissions: a `session/request_permission` server request becomes the
    // pending-input signal (answered via `answerApproval`). Any other blocking
    // server request (Cursor's `cursor/ask_question` / `cursor/create_plan`
    // extensions, etc.) is rejected with a JSON-RPC error rather than an empty
    // `{}` result — a bare `{}` would corrupt those request shapes. (They could
    // later ride this same pending-input surface instead of being rejected.)
    yield* Stream.fromQueue(transport.serverRequests).pipe(
      Stream.runForEach((request) =>
        Effect.gen(function* () {
          if (request.method !== "session/request_permission") {
            yield* transport
              .respondError(request.id, { code: -32601, message: `Unsupported request: ${request.method}` })
              .pipe(Effect.ignore)
            return
          }
          const params: RequestPermissionParams = decodePermissionParams(request.params).pipe(
            Option.getOrElse(() => ({}) as RequestPermissionParams),
          )
          const command = str(obj(params.toolCall?.rawInput)?.["command"]) ?? params.toolCall?.title ?? null
          const approval: PendingApproval = {
            id: request.id,
            approvalId: null,
            itemId: params.toolCall?.toolCallId ?? null,
            command,
            availableDecisions: params.options ?? [],
          }
          yield* SubscriptionRef.update(pendingApprovals, (list) => [...list, approval])
        }),
      ),
      Effect.forkScoped,
    )

    const runTurn = (text: string): Effect.Effect<TurnResult, AppServerDriverError> =>
      Effect.gen(function* () {
        // ACP never echoes the user turn, so synthesize its message row from the
        // prompt text (ordered before any of this turn's updates).
        items.push({ kind: "message", role: "user", text })

        // The `session/prompt` response is the turn-completion signal. The transport
        // routes stdout through one sequential fiber, so every `session/update` for
        // this turn was offered onto the notifications queue before the response
        // resolved — fold after the response: take the whole buffered batch at once
        // and flush the trailing assistant text. (No concurrent fold, so no window
        // between a `Queue.take` and the fold in which an update could be dropped.)
        const result = yield* transport
          .request("session/prompt", { sessionId, prompt: [{ type: "text", text }] })
          .pipe(wrap("session/prompt failed"))

        const updates = yield* Queue.clear(transport.notifications)
        for (const n of updates) foldNotification(n)
        flushText()

        const stopReason = decodePromptResult(result).pipe(
          Option.map((r) => r.stopReason),
          Option.getOrUndefined,
        )
        const rows = normalizeAcpSession(items.slice(), {
          nativeSessionId: sessionId,
          workspaceRoot: options.cwd,
          sourcePath: `acp:${sessionId}`,
          model: options.model ?? null,
        })
        return { status: statusFromStopReason(stopReason), rows }
      })

    const answerApproval = (id: number | string, decision: unknown): Effect.Effect<void, AppServerDriverError> =>
      transport
        .respond(id, { outcome: { outcome: "selected", optionId: decision } })
        .pipe(
          Effect.andThen(
            SubscriptionRef.update(pendingApprovals, (list) => list.filter((approval) => approval.id !== id)),
          ),
          wrap("answerApproval failed"),
        )

    return { threadId: sessionId, runTurn, pendingApprovals, answerApproval }
  })
