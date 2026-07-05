import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  type ChatMessageUpsertMode,
  hookSignalToChatMessageDrafts,
} from "../hooks/chat-message.js"
import { composerOptimisticUserKey } from "../chat-message-keys.js"
import { nowIso } from "../clock.js"
import type { HookSignal } from "../hooks/signals.js"
import { ArcStore } from "../db/store.js"
import type { ChatMessageRow, TargetSessionRow } from "../db/schema.js"
import type { ExtractedRows } from "../ingest/db/schema.js"
import { IngestStore } from "../ingest/db/store.js"
import type { ChatMessage } from "../../shared/chat-message.js"
import type { PendingRequest } from "../../shared/chat-request.js"
import { type ChatId, newArcId, type TargetId } from "../../shared/ids.js"
import { TargetSessionManager } from "./TargetSessionManager.js"
import { SessionRuntimeRouter } from "./SessionRuntimeRouter.js"
import { ChatService } from "./ChatService.js"
import { LocalModelService } from "./LocalModelService.js"
import { ActivityEventService } from "./ActivityEventService.js"
import { arcRequestError } from "../errors.js"
import type { ArcRequestError } from "../errors.js"
import { bestEffort } from "./failure-policy.js"
import { hookInputObj, str } from "../hooks/hook-input.js"
import {
  asProvider,
  isUndecodableRequestRow,
  pendingRequestKind,
  rowToChatMessage,
  titleSeedFromMessages,
} from "./chat-message/row-projection.js"
import {
  chatIdFromSignal,
  isPermissionRequestSignal,
  isPermissionResolutionSignal,
  rawHookSignalFromRow,
} from "./chat-message/signal-projection.js"
import {
  ARTIFACT_KINDS,
  artifactRow,
  type ArtifactProjectionContext,
} from "./chat-message/artifact-projection.js"

export class ChatMessageService extends Context.Service<
  ChatMessageService,
  {
    readonly listForChat: (chatId: string) => Effect.Effect<ReadonlyArray<ChatMessage>, SqlError>
    /** A single chat-message row hydrated to a {@link ChatMessage} (provider
     * derived from its target session), or null when the id is unknown or its
     * row is hidden from the timeline (an undecodable legacy request). */
    readonly getById: (id: string) => Effect.Effect<ChatMessage | null, SqlError>
    /** every still-pending target-originated request, across all chats */
    readonly listPending: Effect.Effect<ReadonlyArray<PendingRequest>, SqlError>
    readonly changes: Stream.Stream<{ readonly chatId: ChatId }>
    readonly ingestSignal: (signal: HookSignal) => Effect.Effect<number, never>
    readonly ingestArtifactSession: (rows: ExtractedRows) => Effect.Effect<number, never>
    /** Mark a detached target's still-pending requests superseded, and publish a
     * change so the sidebar's pending flag clears. Best-effort; never fails. */
    readonly supersedePendingForTarget: (targetSessionId: TargetId) => Effect.Effect<number, never>
    readonly reprojectChat: (chatId: ChatId) => Effect.Effect<{ readonly deleted: number; readonly inserted: number }, never>
    readonly sendPrompt: (req: {
      readonly chatId: ChatId
      readonly targetSessionId: TargetId
      readonly text: string
    }) => Effect.Effect<ChatMessage, ArcRequestError | SqlError>
  }
>()("ChatMessageService") {}

// User text is transcript-owned (see the userKind branch of ARTIFACT_KINDS). When
// true, the composer also writes an optimistic echo that is reconciled onto the
// transcript row for instant feedback; flip to false to test the pure-transcript
// path, where the bubble lands on the transcript-watch tick with no echo.
const USER_OPTIMISTIC_ECHO = true

export const ChatMessageServiceLive = Layer.effect(
  ChatMessageService,
  Effect.gen(function* () {
    const db = yield* ArcStore
    const ingest = yield* IngestStore
    const sessions = yield* TargetSessionManager
    const router = yield* SessionRuntimeRouter
    const chats = yield* ChatService
    const localModel = yield* LocalModelService
    const activity = yield* ActivityEventService
    const updates = yield* PubSub.unbounded<{ readonly chatId: ChatId }>()
    const livePendingPermissions = new Map<TargetId, PendingRequest>()

    const recordPendingEvent = (
      kind: string,
      params: {
        readonly chatId: string
        readonly targetSessionId: string
        readonly reason: string
        readonly provider?: string | null
        readonly nativeToolId?: string | null
        readonly toolName?: string | null
      },
    ) =>
      activity.record({
        chatId: params.chatId,
        targetSessionId: params.targetSessionId,
        source: "chat-message-service",
        kind,
        actor: params.provider ?? null,
        payload: {
          chatId: params.chatId,
          targetSessionId: params.targetSessionId,
          reason: params.reason,
          provider: params.provider ?? null,
          nativeToolId: params.nativeToolId ?? null,
          toolName: params.toolName ?? null,
        },
      })

    const listForChat = (chatId: string) =>
      Effect.gen(function* () {
        const sessions = yield* db.targetSessionsForChat(chatId)
        const providerByTarget = new Map(sessions.map((s) => [s.id, asProvider(s.provider)]))
        const rows = yield* db.loadChatMessagesForChat(chatId)
        return rows
          .filter((row) => !isUndecodableRequestRow(row))
          .map((row) => rowToChatMessage(row, row.targetSessionId ? providerByTarget.get(row.targetSessionId) : undefined))
      })

    const getById = (id: string) =>
      Effect.gen(function* () {
        const row = yield* db.loadChatMessageById(id)
        // Hidden-from-timeline rows (undecodable legacy requests) read as absent,
        // so a `message_…` ref behaves identically to how the chat shows it.
        if (!row || isUndecodableRequestRow(row)) return null
        const provider = row.targetSessionId
          ? asProvider(
              (yield* db.targetSessionsForChat(row.chatId)).find((s) => s.id === row.targetSessionId)?.provider,
            )
          : undefined
        return rowToChatMessage(row, provider)
      })

    const listPending = db.loadPendingRequests.pipe(
      Effect.map((rows) =>
        [
          ...rows.map((row): PendingRequest => ({
            chatId: row.chatId,
            targetSessionId: row.targetSessionId,
            kind: pendingRequestKind(row.requestJson),
          })),
          ...livePendingPermissions.values(),
        ],
      ),
    )

    // The single write seam for projected chat rows: every hook draft and every
    // artifact projection lands here, so the upsert precedence (the mode) and the
    // best-effort logging policy are applied in one place.
    const upsertProjected = (row: ChatMessageRow, mode: ChatMessageUpsertMode, label: string) =>
      db.upsertChatMessage(row, mode).pipe(bestEffort(`${label} persist failed`, false))

    const persistSignalDrafts = (
      signal: HookSignal,
      chatId: ChatId,
      roleFilter?: ChatMessageRow["role"],
    ) =>
      Effect.gen(function* () {
        const drafts = hookSignalToChatMessageDrafts(signal).filter((draft) =>
          roleFilter === undefined || draft.role === roleFilter
        )

        let changed = 0
        const targetSessionId = signal.arcTargetSessionId

        if (targetSessionId && isPermissionRequestSignal(signal)) {
          livePendingPermissions.set(targetSessionId, { chatId, targetSessionId, kind: "permission" })
          const input = hookInputObj(signal)
          yield* recordPendingEvent("pending_permission_set", {
            chatId,
            targetSessionId,
            reason: "permission_request",
            provider: signal.provider,
            toolName: str(input?.["tool_name"] ?? input?.["toolName"]),
          })
          changed += 1
        } else if (targetSessionId && isPermissionResolutionSignal(signal)) {
          if (livePendingPermissions.delete(targetSessionId)) {
            const input = hookInputObj(signal)
            yield* recordPendingEvent("pending_permission_cleared", {
              chatId,
              targetSessionId,
              reason: signal.declaredEvent,
              provider: signal.provider,
              nativeToolId: signal.native.toolUseId,
              toolName: str(input?.["tool_name"] ?? input?.["toolName"]),
            })
            changed += 1
          }
        }

        if (drafts.length === 0) return changed
        for (const draft of drafts) {
          const row: ChatMessageRow = {
            id: newArcId("message"),
            chatId,
            targetSessionId: signal.arcTargetSessionId,
            role: draft.role,
            turnId: draft.turnId,
            messageId: draft.messageId,
            chunkIndex: draft.chunkIndex,
            body: draft.body,
            status: draft.status,
            model: draft.model ?? null,
            requestJson: draft.request ? JSON.stringify(draft.request) : null,
            // Hook drafts are request/subagent/assistant rows; user turns (the
            // only injected-message carrier) are transcript-owned, so never here.
            injectedFromTargetSessionId: null,
            injectedTargetMessageId: null,
            occurredAt: signal.observedAt,
            source: `hook:${signal.provider}`,
            dedupKey: draft.dedupKey,
          }
          let ok = false
          if (draft.role === "user" && draft.mode === "insert") {
            ok = yield* db
              .reconcileComposerOptimisticUser(row)
              .pipe(bestEffort("composer user reconcile failed", false))
          }
          if (!ok) {
            ok = yield* upsertProjected(row, draft.mode, `chat message (${draft.role})`)
          }
          if (ok) changed += 1
        }

        return changed
      })

    const ingestSignal = (signal: HookSignal) =>
      Effect.gen(function* () {
        let chatId = chatIdFromSignal(signal)
        if (!chatId && signal.arcTargetSessionId) {
          chatId = yield* db.chatIdForTargetSession(signal.arcTargetSessionId)
        }
        if (!chatId) return 0

        const changed = yield* persistSignalDrafts(signal, chatId)

        if (changed > 0) yield* PubSub.publish(updates, { chatId })
        return changed
        // Best-effort observation: lossy hook ingestion never fails the caller.
      }).pipe(bestEffort("chat message ingest failed", 0))

    // The composer optimistic-echo reconcile and the hook-user -> meta relabel are
    // the two store-touching seams the pure projection kinds need; wrapped here to
    // never fail (best-effort policy applied once) and handed to the kinds via the
    // projection context, so artifact-projection.ts stays free of the store.
    const reconcileComposerUser = USER_OPTIMISTIC_ECHO
      ? (row: ChatMessageRow) =>
          db
            .reconcileComposerOptimisticUser(row)
            .pipe(bestEffort("artifact user reconcile failed", false))
      : undefined

    const relabelHookUserAsMeta = (params: {
      readonly targetSessionId: string
      readonly body: string
      readonly dedupKey: string
      readonly messageId: string
    }) =>
      db.relabelHookUserAsMeta(params).pipe(bestEffort("artifact meta relabel failed", false))

    const projectArtifactSession = (
      rows: ExtractedRows,
      target: { readonly id: TargetId; readonly chatId: ChatId },
    ) =>
      Effect.gen(function* () {
        let changed = 0
        const projected = yield* db.loadChatMessagesForChat(target.chatId)
        const delivered = yield* db.listDeliveredInjectedMessages(target.id)
        const injectedDeliveries = new Map(delivered.map((d) => [d.id, d.senderTargetSessionId] as const))
        const ctx: ArtifactProjectionContext = {
          rows,
          target,
          projected,
          projectionTime: yield* nowIso,
          injectedDeliveries,
          reconcileComposerUser,
          relabelHookUserAsMeta,
        }
        for (const kind of ARTIFACT_KINDS) {
          for (const spec of kind(ctx)) {
            const row = artifactRow(target, rows.session.provider, {
              role: spec.role,
              messageId: spec.messageId,
              body: spec.body,
              status: spec.status,
              occurredAt: spec.occurredAt,
              dedupKey: spec.dedupKey,
              requestJson: spec.requestJson ?? null,
              model: spec.model ?? null,
              injectedFromTargetSessionId: spec.injectedFromTargetSessionId ?? null,
              injectedTargetMessageId: spec.injectedTargetMessageId ?? null,
            })
            if (spec.reconcile) {
              const claimed = yield* spec.reconcile(row)
              if (claimed) {
                changed += 1
                continue
              }
            }
            const upsertMode =
              rows.session.provider === "cursor" ? "replace" : "replace_keep_time"
            const ok = yield* upsertProjected(row, upsertMode, spec.label)
            if (ok) changed += 1
          }
        }
        return changed
      })

    const ingestArtifactSession = (rows: ExtractedRows) =>
      Effect.gen(function* () {
        const target = yield* db.targetSessionForNative(
          rows.session.provider,
          rows.session.nativeSessionId,
        )
        if (!target) return 0

        const changed = yield* projectArtifactSession(rows, target)
        if (changed > 0) yield* PubSub.publish(updates, { chatId: target.chatId })
        return changed
        // Best-effort observation: lossy artifact projection never fails the caller.
      }).pipe(bestEffort("artifact chat message ingest failed", 0))

    const targetForStoredSession = (
      targets: ReadonlyArray<TargetSessionRow>,
      provider: string,
      nativeSessionId: string,
    ): { readonly id: TargetId; readonly chatId: ChatId } | null => {
      const exact = targets.find((target) =>
        target.provider === provider && target.nativeSessionId === nativeSessionId
      )
      if (exact) return { id: exact.id, chatId: exact.chatId }

      const unbound = targets.filter((target) =>
        target.provider === provider &&
        !target.nativeSessionId &&
        target.state !== "exited"
      )
      return unbound.length === 1 ? { id: unbound[0]!.id, chatId: unbound[0]!.chatId } : null
    }

    const reprojectChat = (chatId: ChatId) =>
      Effect.gen(function* () {
        const targets = yield* db.targetSessionsForChat(chatId)
        const deleted = yield* db.deleteRequestMessagesForChat(chatId)
        let inserted = 0

        for (const target of targets) {
          const rawRows = yield* db.loadRawHookSignalsForTarget(target.id)
          for (const row of rawRows) {
            const signal = rawHookSignalFromRow(row)
            if (!signal || chatIdFromSignal(signal) !== chatId) continue
            inserted += yield* persistSignalDrafts(signal, chatId, "request")
          }
        }

        const sessions = yield* ingest.listSessions()
        for (const session of sessions) {
          const target = targetForStoredSession(targets, session.provider, session.nativeSessionId)
          if (!target) continue
          const rows = yield* ingest.getSession(session.id)
          if (!rows) continue
          inserted += yield* projectArtifactSession(rows, target)
        }

        if (deleted > 0 || inserted > 0) yield* PubSub.publish(updates, { chatId })
        return { deleted, inserted }
        // Best-effort observation: a reprojection failure leaves the prior
        // projection intact and never fails the manual reproject RPC.
      }).pipe(bestEffort(`chat reproject failed (${chatId})`, { deleted: 0, inserted: 0 }))

    const sendPrompt = (req: {
      readonly chatId: ChatId
      readonly targetSessionId: TargetId
      readonly text: string
    }) =>
      Effect.gen(function* () {
        // Normalize to the form every provider reports back through its hook
        // (all of them trim the prompt). The optimistic composer row is joined to
        // the canonical hook row by exact body match, so storing the raw text —
        // typically with a trailing newline — would miss reconciliation and leave
        // a duplicate user message in the transcript.
        const text = req.text.trim()
        if (text.length === 0) {
          return yield* Effect.fail(arcRequestError("Prompt cannot be empty"))
        }

        const targets = yield* db.targetSessionsForChat(req.chatId)
        const stored = targets.find((target) => target.id === req.targetSessionId)
        if (!stored) {
          return yield* Effect.fail(
            arcRequestError(`Target session "${req.targetSessionId}" is not in this chat`),
          )
        }

        // rpc (app-server) sessions live under RpcSessionManager, not the PTY
        // manager, and have no "attached" byte-stream — skip the PTY liveness
        // check for them (router.submit reports its own not-running).
        const isRpc = yield* router.ownsRpc(req.targetSessionId)
        if (!isRpc) {
          const live = (yield* sessions.list).find((session) => session.id === req.targetSessionId)
          if (!live?.attached) {
            return yield* Effect.fail(
              arcRequestError(
                `Target session "${stored.provider}" is not running — attach or resume it before sending`,
              ),
            )
          }
        }

        const occurredAt = yield* nowIso
        const messageId = newArcId("message")
        const row: ChatMessageRow = {
          id: messageId,
          chatId: req.chatId,
          targetSessionId: req.targetSessionId,
          role: "user",
          turnId: null,
          messageId: null,
          chunkIndex: null,
          body: text,
          status: "final",
          model: null,
          requestJson: null,
          // The user typed this in the composer — a genuine human turn, not an
          // agent-injected message.
          injectedFromTargetSessionId: null,
          injectedTargetMessageId: null,
          occurredAt,
          source: "composer",
          dedupKey: composerOptimisticUserKey(req.targetSessionId, messageId),
        }

        // Optimistic echo for instant feedback; the durable row is transcript-
        // owned and reconciled onto this one when it lands. Skipped in the
        // pure-transcript mode, where the bubble appears on the next projection.
        if (USER_OPTIMISTIC_ECHO) {
          const ok = yield* db
            .upsertChatMessage(row, "insert")
            .pipe(bestEffort("composer prompt persist failed", false))
          if (!ok) {
            return yield* Effect.fail(arcRequestError("Failed to record prompt in chat transcript"))
          }
          // Publish now so the bubble shows immediately — an rpc turn holds this
          // handler open until it completes, so the end-of-send publish would
          // otherwise delay the user's own message until codex replies.
          yield* PubSub.publish(updates, { chatId: req.chatId })
        }

        const delivery = yield* router
          .submit({ instanceId: req.targetSessionId, text })
          .pipe(
            Effect.catchTag("CodexDriverError", (e) =>
              Effect.logWarning(`rpc turn failed (${req.targetSessionId}): ${e.message}`).pipe(
                Effect.as({ accepted: false as const }),
              ),
            ),
          )
        if (!delivery.accepted) {
          yield* db.deleteChatMessageByDedupKey(row.dedupKey).pipe(
            Effect.tapError((e: SqlError) =>
              Effect.logWarning(`composer prompt rollback failed: ${e}`),
            ),
            Effect.ignore,
          )
          // The optimistic echo already published to show the bubble; publish the
          // rollback too, or the renderer keeps showing a message whose row is gone.
          yield* PubSub.publish(updates, { chatId: req.chatId })
          return yield* Effect.fail(
            arcRequestError(
              `Target session "${stored.provider}" is not attached — prompt was not delivered`,
            ),
          )
        }

        // An rpc turn returns its cumulative rows; project them into the chat
        // timeline (the driver wrote IngestStore, the renderer reads the ArcStore
        // projection). A pty turn's transcript arrives via the file watcher instead.
        if ("rows" in delivery && delivery.rows) {
          yield* ingestArtifactSession(delivery.rows)
        }

        const titleSeed = titleSeedFromMessages(
          yield* db.loadChatMessagesForChat(req.chatId).pipe(
            Effect.tapError((e: SqlError) =>
              Effect.logWarning(`chat title seed load failed: ${e}`),
            ),
            Effect.orElseSucceed(() => [row] as ReadonlyArray<ChatMessageRow>),
          ),
          text,
        )

        yield* localModel.generateChatTitle({ firstUserPrompt: titleSeed }).pipe(
          Effect.flatMap((title) => {
            if (title) return chats.updateTitleIfDefault(req.chatId, title)
            return localModel.status.pipe(
              Effect.flatMap((status) =>
                Effect.logWarning(`local chat title generation skipped: ${status.message}`),
              ),
              Effect.as(false),
            )
          }),
          bestEffort(`local chat title generation failed (${req.chatId})`, false),
        )

        yield* PubSub.publish(updates, { chatId: req.chatId })
        return rowToChatMessage(row)
      })

    const supersedePendingForTarget = (targetSessionId: TargetId) =>
      Effect.gen(function* () {
        const clearedLive = livePendingPermissions.delete(targetSessionId) ? 1 : 0
        const superseded = yield* db.supersedePendingRequestsForTarget(targetSessionId)
        if (superseded > 0 || clearedLive > 0) {
          const chatId = yield* db.chatIdForTargetSession(targetSessionId)
          if (chatId) {
            if (clearedLive > 0) {
              yield* recordPendingEvent("pending_permission_cleared", {
                chatId,
                targetSessionId,
                reason: "target_detach",
              })
            }
            yield* PubSub.publish(updates, { chatId })
          }
        }
        return superseded + clearedLive
        // Best-effort lifecycle reconciliation: a write failure is logged, never
        // surfaced to the exit/boot path that triggered it.
      }).pipe(bestEffort(`supersede pending failed (${targetSessionId})`, 0))

    const changes = Stream.fromPubSub(updates)

    return { listForChat, getById, listPending, changes, ingestSignal, ingestArtifactSession, supersedePendingForTarget, reprojectChat, sendPrompt }
  }),
)
