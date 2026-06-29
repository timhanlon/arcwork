import { Context, Effect, Layer } from "effect"
import * as Semaphore from "effect/Semaphore"
import { nowIso } from "../clock.js"
import { arcId, arcIdOrNull, newArcId } from "../../shared/ids.js"
import { withInjectedMarker } from "../../shared/injected-message.js"
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
    /** Queue a message for a target session and attempt immediate delivery.
     * `senderTargetSessionId` is the authoritative sending agent (from the
     * caller's MCP provenance); it rides the delivered marker so the receiving
     * turn is attributed to that agent rather than the human user. `sender` is an
     * optional free-text display label (no longer the identity). */
    readonly enqueue: (
      targetSessionId: string,
      body: string,
      sender?: string,
      senderTargetSessionId?: string,
    ) => Effect.Effect<void, never>
    /** Deliver any pending messages if the session is idle; best-effort no-op
     * otherwise (mid-turn, detached, or nothing queued). Called on turn close. */
    readonly flushTo: (targetSessionId: string) => Effect.Effect<void, never>
  }
>()("TargetInboxService") {}

/** One paste for a single-sender group of pending messages.
 *
 * An agent-attributed group (it has a `senderTargetSessionId`) is prefixed with
 * the parseable injected marker carrying that sender, so projection re-attributes
 * the resulting user turn to the sending agent instead of the human user. A
 * sender-less group (a system/user nudge) keeps the legacy formatting: a lone
 * bare message reads as a plain user turn; free-text–labelled ones are marked.
 *
 * Groups never span distinct senders (the flush delivers one group per turn), so
 * one paste maps to one rendered chat row with unambiguous attribution. */
const formatGroup = (msgs: ReadonlyArray<TargetMessageRow>, senderLabel: string): string => {
  const head = msgs[0]!
  if (head.senderTargetSessionId) {
    // Carry the head inbox row id as the marker's correlation key — projection
    // verifies it against the delivered row before re-attributing (the head is
    // always one of the rows we mark delivered, so it resolves; a batch points at
    // the head as its representative breadcrumb).
    return withInjectedMarker(
      head.senderTargetSessionId,
      senderLabel,
      msgs.map((m) => m.body).join("\n\n"),
      head.id,
    )
  }
  return msgs.length === 1 && !head.sender
    ? head.body
    : msgs.map((m) => (m.sender ? `📨 Message from ${m.sender}:\n${m.body}` : `📨 ${m.body}`)).join("\n\n")
}

export const TargetInboxServiceLive = Layer.effect(
  TargetInboxService,
  Effect.gen(function* () {
    const store = yield* ArcStore
    const sessions = yield* TargetSessionManager
    const liveStates = yield* LiveTargetStateService

    // Serialize flushes so the read-pending → submit → ack window can't overlap:
    // the enqueue path and the controller's turn-close path both call `flushTo`,
    // and without this lock both could read the same pending rows and paste the
    // batch twice before either ack commits. One global permit (not per-session)
    // keeps it simple and is cheap — a flush is an in-memory check plus a PTY
    // write; the loser re-reads and finds the rows already delivered. Ack stays
    // on-surface (stamped only after an accepted paste), so crash-safety holds.
    const flushLock = yield* Semaphore.make(1)

    const flushTo = (targetSessionId: string): Effect.Effect<void, never> =>
      flushLock
        .withPermits(1)(
          Effect.gen(function* () {
            const states = yield* liveStates.list
            // "idle" already implies attached + not exited + no open turn + no
            // pending question/permission (see deriveActivity) — exactly when a
            // pasted turn is safe. Any other activity: leave it queued.
            if (states.find((s) => s.targetSessionId === targetSessionId)?.activity !== "idle") return
            const pending = yield* store.listPendingTargetMessages(targetSessionId)
            if (pending.length === 0) return
            // Deliver one sender-group per turn: never merge distinct senders into
            // a single pasted turn (it would render as one bubble with the senders
            // conflated). The group is the CONTIGUOUS prefix of the oldest sender —
            // a later same-sender message after an intervening other sender must
            // not jump the queue, so FIFO holds across senders. The rest stay
            // pending and flush on the next turn-close.
            const head = pending[0]!
            const group: Array<typeof head> = []
            for (const p of pending) {
              if (p.senderTargetSessionId !== head.senderTargetSessionId) break
              group.push(p)
            }
            const senderLabel = head.senderTargetSessionId
              ? (yield* sessions.list).find((s) => s.id === head.senderTargetSessionId)?.provider ??
                head.sender ??
                "agent"
              : ""
            const { accepted } = yield* sessions.submit({
              instanceId: targetSessionId,
              text: formatGroup(group, senderLabel),
            })
            if (!accepted) return // no live PTY — leave pending, retry on the next idle
            const deliveredAt = yield* nowIso
            yield* store.markTargetMessagesDelivered(
              group.map((p) => p.id),
              deliveredAt,
            )
          }),
        )
        .pipe(
          Effect.catch((cause) =>
            Effect.logWarning(`target inbox flush failed (${targetSessionId}): ${cause}`),
          ),
        )

    const enqueue = (
      targetSessionId: string,
      body: string,
      sender?: string,
      senderTargetSessionId?: string,
    ): Effect.Effect<void, never> =>
      Effect.gen(function* () {
        const createdAt = yield* nowIso
        yield* store.enqueueTargetMessage({
          id: newArcId("inbox"),
          targetSessionId: arcId("target", targetSessionId),
          body,
          sender: sender ?? null,
          senderTargetSessionId: arcIdOrNull("target", senderTargetSessionId),
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
