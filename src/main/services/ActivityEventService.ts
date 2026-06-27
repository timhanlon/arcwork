import { Context, Effect, Layer, PubSub, Stream } from "effect"
import { nowIso } from "../clock.js"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { ActivityEventDraft } from "../hooks/agent-event.js"
import { hookSignalToActivityDrafts } from "../hooks/agent-event.js"
import type { HookSignal } from "../hooks/signals.js"
import { ArcStore } from "../db/store.js"
import type { ActivityEventRow } from "../db/schema.js"
import type { ActivityEvent } from "../../shared/activity-event.js"
import { arcId, arcIdOrNull, type ChatId, newArcId } from "../../shared/ids.js"
import { bestEffort } from "./failure-policy.js"

/**
 * Normalizes hook signals into durable `activity_events` rows. Hooks are
 * transport; this service owns the product stream (AgentEvent → activity kind).
 */
export class ActivityEventService extends Context.Service<
  ActivityEventService,
  {
    readonly listForChat: (chatId: string) => Effect.Effect<ReadonlyArray<ActivityEvent>, SqlError>
    /** Activity events that name a unit of work in their payload (the handoff
     * create/report trail), oldest first — the monitoring read model's source for
     * the latest structured report state. */
    readonly listForWork: (
      workRefId: string,
    ) => Effect.Effect<ReadonlyArray<ActivityEvent>, SqlError>
    readonly changes: Stream.Stream<{ readonly chatId: ChatId }>
    readonly record: (event: {
      readonly workspaceRoot?: string | null
      readonly chatId?: string | null
      readonly targetSessionId?: string | null
      readonly source: string
      readonly kind: string
      readonly actor?: string | null
      readonly payload?: Record<string, unknown>
      readonly dedupKey?: string | null
    }) => Effect.Effect<boolean, never>
    readonly ingestSignal: (signal: HookSignal) => Effect.Effect<number, never>
  }
>()("ActivityEventService") {}

const parsePayload = (json: string): Record<string, unknown> => {
  try {
    const value: unknown = JSON.parse(json)
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>
    }
  } catch {
    // fall through
  }
  return {}
}

const rowToActivityEvent = (row: ActivityEventRow): ActivityEvent => ({
  _tag: "ActivityEvent",
  id: row.id,
  chatId: row.workContextId ?? undefined,
  targetSessionId: row.targetSessionId ?? undefined,
  source: row.source,
  kind: row.kind,
  actor: row.actor ?? undefined,
  occurredAt: row.occurredAt,
  payload: parsePayload(row.payloadJson),
})

const draftToRow = (signal: HookSignal, draft: ActivityEventDraft): ActivityEventRow => ({
  id: newArcId("activity"),
  workspaceRoot: signal.cwd ?? "",
  workContextId: signal.arcChatSessionId,
  userActionId: null,
  targetSessionId: signal.arcTargetSessionId,
  source: `hook:${signal.provider}`,
  kind: draft.kind,
  actor: signal.provider,
  occurredAt: signal.observedAt,
  payloadJson: JSON.stringify(draft.payload),
  provenanceJson: JSON.stringify(draft.provenance),
  dedupKey: draft.dedupKey,
})

const chatIdFromSignal = (signal: HookSignal): ChatId | null =>
  signal.arcChatSessionId ?? signal.arc.chatId ?? null

export const ActivityEventServiceLive = Layer.effect(
  ActivityEventService,
  Effect.gen(function* () {
    const db = yield* ArcStore
    const updates = yield* PubSub.unbounded<{ readonly chatId: ChatId }>()

    const listForChat = (chatId: string) =>
      db.loadActivityEventsForChat(chatId).pipe(Effect.map((rows) => rows.map(rowToActivityEvent)))

    const listForWork = (workRefId: string) =>
      db.loadActivityEventsForWork(workRefId).pipe(Effect.map((rows) => rows.map(rowToActivityEvent)))

    const persistDraft = (signal: HookSignal, draft: ActivityEventDraft) =>
      db
        .insertActivityEvent(draftToRow(signal, draft))
        .pipe(bestEffort(`activity event persist failed (${draft.kind})`, false))

    const record = (event: {
      readonly workspaceRoot?: string | null
      readonly chatId?: string | null
      readonly targetSessionId?: string | null
      readonly source: string
      readonly kind: string
      readonly actor?: string | null
      readonly payload?: Record<string, unknown>
      readonly dedupKey?: string | null
    }) =>
      Effect.gen(function* () {
        // Console echo of the watch/ingest/pending lifecycle. `record` is used
        // only by these observability callers, so this surfaces exactly them in
        // the dev terminal (Debug floor) and stays silent in stable (Info).
        const detail = [
          event.payload?.["trigger"],
          event.payload?.["eventType"],
          event.payload?.["reason"],
          event.payload?.["durationMs"] != null ? `${String(event.payload["durationMs"])}ms` : null,
        ]
          .filter((v) => v != null)
          .join(" ")
        yield* Effect.logDebug(
          `activity ${event.source}/${event.kind}${detail ? ` ${detail}` : ""}${event.targetSessionId ? ` ${event.targetSessionId}` : ""}`,
        )
        const occurredAt = yield* nowIso
        const row: ActivityEventRow = {
          id: newArcId("activity"),
          workspaceRoot: event.workspaceRoot ?? "",
          workContextId: arcIdOrNull("chat", event.chatId),
          userActionId: null,
          targetSessionId: arcIdOrNull("target", event.targetSessionId),
          source: event.source,
          kind: event.kind,
          actor: event.actor ?? null,
          occurredAt,
          payloadJson: JSON.stringify(event.payload ?? {}),
          provenanceJson: JSON.stringify({ source: event.source }),
          dedupKey: event.dedupKey ?? null,
        }
        const inserted = yield* db
          .insertActivityEvent(row)
          .pipe(bestEffort(`activity event persist failed (${event.kind})`, false))
        if (inserted && event.chatId) {
          yield* PubSub.publish(updates, { chatId: arcId("chat", event.chatId) })
        }
        return inserted
      }).pipe(bestEffort(`activity event record failed (${event.kind})`, false))

    const ingestSignal = (signal: HookSignal) =>
      Effect.gen(function* () {
        const drafts = hookSignalToActivityDrafts(signal)
        if (drafts.length === 0) return 0
        let inserted = 0
        for (const draft of drafts) {
          const ok = yield* persistDraft(signal, draft)
          if (ok) inserted += 1
        }
        if (inserted > 0) {
          let chatId = chatIdFromSignal(signal)
          if (!chatId && signal.arcTargetSessionId) {
            chatId = yield* db.chatIdForTargetSession(signal.arcTargetSessionId)
          }
          if (chatId) yield* PubSub.publish(updates, { chatId })
        }
        return inserted
        // Best-effort observation: lossy hook ingestion never fails the caller.
      }).pipe(bestEffort("hook signal ingest failed", 0))

    const changes = Stream.fromPubSub(updates)

    return { listForChat, listForWork, changes, record, ingestSignal }
  }),
)
