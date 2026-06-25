import { Context, Effect, Layer } from "effect"
import { nowIso } from "../clock.js"
import { arcId, newArcId } from "../../shared/ids.js"
import type { TargetMessageRow } from "../db/schema.js"
import { ArcStore } from "../db/store.js"
import { LiveTargetStateService } from "./LiveTargetStateService.js"
import { TargetSessionManager } from "./TargetSessionManager.js"

/**
 * Deliver messages INTO a running target session — the back-channel that closes
 * the orchestration loop (a parent's follow-up, a user nudge, a peer message),
 * since `arc.agent.spawn` + priming is otherwise fire-and-forget.
 *
 * Two-path design (borrowed from Cotal's connector, minus its NATS substrate):
 * messages queue in the durable `target_messages` inbox, and we *deliver by
 * waking* — we own the PTY, so the wake IS the delivery: when the session is
 * idle we paste the pending batch as its next turn. When it's mid-turn we leave
 * the rows pending and flush on the next turn boundary (the controller calls
 * {@link flushTo} when a turn closes).
 *
 * Ack-on-surface: a row's `delivered_at` is stamped only once the paste was
 * accepted by a live PTY. A crash, a detached child, or a missed flush leaves it
 * pending, so it redelivers on the next idle — never acked into the void.
 */
export class TargetInboxService extends Context.Service<
  TargetInboxService,
  {
    /** Queue a message for a target session and attempt immediate delivery. */
    readonly enqueue: (
      targetSessionId: string,
      body: string,
      sender?: string,
    ) => Effect.Effect<void, never>
    /** Deliver any pending messages if the session is idle; best-effort no-op
     * otherwise (mid-turn, detached, or nothing queued). Called on turn close. */
    readonly flushTo: (targetSessionId: string) => Effect.Effect<void, never>
  }
>()("TargetInboxService") {}

/** One paste for the whole pending batch. A lone unattributed message reads as a
 * plain user turn; anything attributed (or batched) is labelled so the agent can
 * tell injected peer/parent traffic from its own continuation. */
const formatBatch = (msgs: ReadonlyArray<TargetMessageRow>): string =>
  msgs.length === 1 && !msgs[0]!.sender
    ? msgs[0]!.body
    : msgs.map((m) => (m.sender ? `📨 Message from ${m.sender}:\n${m.body}` : `📨 ${m.body}`)).join("\n\n")

export const TargetInboxServiceLive = Layer.effect(
  TargetInboxService,
  Effect.gen(function* () {
    const store = yield* ArcStore
    const sessions = yield* TargetSessionManager
    const liveStates = yield* LiveTargetStateService

    const flushTo = (targetSessionId: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const states = yield* liveStates.list
        // "idle" already implies attached + not exited + no open turn + no
        // pending question/permission (see deriveActivity) — exactly when a
        // pasted turn is safe. Any other activity: leave it queued.
        if (states.find((s) => s.targetSessionId === targetSessionId)?.activity !== "idle") return
        const pending = yield* store.listPendingTargetMessages(targetSessionId)
        if (pending.length === 0) return
        const { accepted } = yield* sessions.submit({
          instanceId: targetSessionId,
          text: formatBatch(pending),
        })
        if (!accepted) return // no live PTY — leave pending, retry on the next idle
        const deliveredAt = yield* nowIso
        yield* store.markTargetMessagesDelivered(
          pending.map((p) => p.id),
          deliveredAt,
        )
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`target inbox flush failed (${targetSessionId}): ${cause}`),
        ),
      )

    const enqueue = (targetSessionId: string, body: string, sender?: string): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso
        yield* store.enqueueTargetMessage({
          id: newArcId("inbox"),
          targetSessionId: arcId("target", targetSessionId),
          body,
          sender: sender ?? null,
          createdAt,
          deliveredAt: null,
        })
        yield* flushTo(targetSessionId)
      }).pipe(
        Effect.catch((cause) =>
          Effect.logWarning(`target inbox enqueue failed (${targetSessionId}): ${cause}`),
        ),
      )

    return { enqueue, flushTo }
  }),
)
