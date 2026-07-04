import { Clock, Context, Effect, Layer } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { newArcId } from "../../shared/ids.js"
import type { TargetSession } from "../../shared/instance.js"
import { ArcStore } from "../db/store.js"
import type { ExtractedRows } from "../ingest/db/schema.js"
import type { CodexDriverError } from "../ingest/providers/codex-appserver/driver.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { ChatService } from "./ChatService.js"
import { ProviderRegistry } from "./ProviderRegistry.js"
import { RpcSessionManager } from "./RpcSessionManager.js"
import {
  type LaunchRequest,
  type StopRequest,
  type SubmitRequest,
  TargetSessionManager,
} from "./TargetSessionManager.js"
import { WorkspaceService } from "./WorkspaceService.js"

/**
 * Dispatches launch/submit/stop across the two session runtimes — the PTY
 * `TargetSessionManager` and the RPC-backed `RpcSessionManager` — so the rest of
 * the app has one door. Launch picks the runtime by **intent** (`req.runtime`),
 * never by provider identity: codex declares both `interactive` and `appServer`,
 * so it can be launched either way. Submit/stop route by *ownership* (which
 * manager holds the id), which needs no persisted kind.
 *
 * The router deliberately does NOT project rpc turns into the chat timeline
 * itself — that would require depending on `ChatMessageService`, which depends
 * back on the router (`sendPrompt`). Instead `submit` returns the turn's `rows`
 * and the caller (`sendPrompt`) projects them, keeping the dependency acyclic.
 */
export class SessionRuntimeRouter extends Context.Service<
  SessionRuntimeRouter,
  {
    readonly launch: (
      req: LaunchRequest,
    ) => Effect.Effect<TargetSession, ArcRequestError | SqlError | CodexDriverError>
    /** Route a submit; `rows` is present for an rpc turn (caller projects it). */
    readonly submit: (
      req: SubmitRequest,
    ) => Effect.Effect<{ readonly accepted: boolean; readonly rows?: ExtractedRows }, CodexDriverError>
    readonly stop: (req: StopRequest) => Effect.Effect<{ readonly stopped: boolean }>
    /** Whether an rpc runtime owns this session id (used to skip PTY-only checks). */
    readonly ownsRpc: (targetSessionId: string) => Effect.Effect<boolean>
  }
>()("arcwork/SessionRuntimeRouter") {}

export const SessionRuntimeRouterLive = Layer.effect(
  SessionRuntimeRouter,
  Effect.gen(function* () {
    const providers = yield* ProviderRegistry
    const workspaces = yield* WorkspaceService
    const chats = yield* ChatService
    const db = yield* ArcStore
    const pty = yield* TargetSessionManager
    const rpc = yield* RpcSessionManager

    const nowIso = Effect.map(Clock.currentTimeMillis, (ms) => new Date(ms).toISOString())
    const ownsRpc = (id: string) => Effect.map(rpc.list, (ids) => ids.includes(id))

    // Create + persist a TargetSession row for an rpc launch, spawn the driver,
    // and bind the thread id so `ingestArtifactSession` can find the target when
    // the caller projects a turn's rows.
    const launchRpc = (req: LaunchRequest) =>
      Effect.gen(function* () {
        const spec = yield* providers.get(req.provider)
        if (!spec?.appServer) {
          return yield* Effect.fail(
            arcRequestError(`Provider "${req.provider}" has no app-server capability`),
          )
        }
        const chat = yield* chats.get(req.chatId)
        const workspace = yield* workspaces.get(req.workspaceId ?? chat.workspaceId)
        const cwd = workspace.path
        const id = newArcId("target")
        const startedAt = yield* nowIso

        yield* db.upsertTargetSession({
          id,
          chatId: req.chatId,
          provider: req.provider,
          origin: req.origin ?? "manual",
          spawnedBy: req.spawnedBy ?? null,
          preset: req.preset ?? null,
          cwd,
          nativeSessionId: null,
          nativeTranscriptPath: null,
          state: "running",
          startedAt,
        })

        const { threadId } = yield* rpc.launch({
          chatId: req.chatId,
          targetSessionId: id,
          cwd,
          command: spec.appServer.launchCmd,
          args: spec.appServer.args,
          sandbox: "workspace-write",
          approvalPolicy: "on-request",
        })
        yield* pty.bindNative(id, threadId)

        return {
          _tag: "TargetSession",
          id,
          provider: req.provider,
          origin: req.origin ?? "manual",
          chatId: req.chatId,
          cwd,
          nativeSessionId: threadId,
          attached: true,
          state: "running",
          startedAt,
        } satisfies TargetSession
      })

    const launch = (req: LaunchRequest) => (req.runtime === "rpc" ? launchRpc(req) : pty.launch(req))

    const submit = (req: SubmitRequest) =>
      Effect.gen(function* () {
        if (yield* ownsRpc(req.instanceId)) {
          return yield* rpc.submit({ targetSessionId: req.instanceId, text: req.text })
        }
        return yield* pty.submit(req)
      })

    const stop = (req: StopRequest) =>
      Effect.gen(function* () {
        if (yield* ownsRpc(req.sessionId)) return yield* rpc.stop(req.sessionId)
        return yield* pty.stop(req)
      })

    return { launch, submit, stop, ownsRpc }
  }),
)
