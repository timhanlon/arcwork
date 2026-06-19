import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect"
import type { TargetSession } from "../../shared/instance.js"
import type { LiveTargetActivity, LiveTargetState } from "../../shared/live-target-state.js"
import type { PendingRequest } from "../../shared/chat-request.js"
import { TargetSessionManager } from "./TargetSessionManager.js"
import { ChatMessageService } from "./ChatMessageService.js"

/**
 * The single source of truth for a target session's *live* activity — the
 * `generating | idle | waiting_* | detached | exited` word the composer and
 * sidebar paint. It is a pure projection over three signals, so both surfaces
 * read one consistent answer instead of each re-deriving status off
 * {@link TargetSession.state} (which is lifecycle, not activity — see
 * shared/live-target-state.ts):
 *
 *   1. PTY ownership + lifecycle — `TargetSessionManager.changes` carries
 *      `attached` (this process holds the live PTY) and the persisted `state`
 *      (only `exited` is read here).
 *   2. Pending questions/permissions — `ChatMessageService.listPending`, the
 *      attention signal (a persisted question row or an in-memory permission).
 *   3. The hook turn lifecycle — `noteTurn`, fed by the controller from the hook
 *      signal stream (UserPromptSubmit opens a turn, Stop closes it). This is the
 *      only input that distinguishes "actively generating" from "attached idle".
 *
 * The open-turn set is ephemeral (a SubscriptionRef, never persisted): it is
 * rebuilt from the live hook stream each process, the same way the PTY map is.
 */
export class LiveTargetStateService extends Context.Service<
  LiveTargetStateService,
  {
    /** Current live activity for every known session. */
    readonly list: Effect.Effect<ReadonlyArray<LiveTargetState>>
    /** Reactive view of `list`: the current projection, then every change. */
    readonly changes: Stream.Stream<ReadonlyArray<LiveTargetState>>
    /** Record a turn transition for a target (open on prompt submit, close on
     * Stop/session end). Idempotent for the same value. */
    readonly noteTurn: (targetSessionId: string, open: boolean) => Effect.Effect<void>
    /** Drop a target's open-turn marker — called when its PTY detaches/exits so a
     * relaunch under the same id does not inherit a stale "generating". */
    readonly clearTurn: (targetSessionId: string) => Effect.Effect<void>
  }
>()("LiveTargetStateService") {}

/**
 * Collapse one session's three signals into its live activity. PTY truth wins
 * first: an exited or detached child cannot be generating, whatever a stale turn
 * marker says. Then attention (approval over input) beats a still-open turn;
 * everything else attached is idle.
 */
export const deriveActivity = (
  session: TargetSession,
  pendingKind: PendingRequest["kind"] | undefined,
  openTurns: ReadonlySet<string>,
): LiveTargetActivity => {
  if (session.state === "exited") return "exited"
  if (session.attached !== true) return "detached"
  if (pendingKind === "permission") return "waiting_for_approval"
  if (pendingKind === "question") return "waiting_for_input"
  if (openTurns.has(session.id)) return "generating"
  return "idle"
}

export const LiveTargetStateServiceLive = Layer.effect(
  LiveTargetStateService,
  Effect.gen(function* () {
    const sessions = yield* TargetSessionManager
    const chatMessages = yield* ChatMessageService
    const openTurns = yield* SubscriptionRef.make(new Set<string>())

    const derive = Effect.gen(function* () {
      const sessionList = yield* sessions.list
      // A pending-list read failure must not blank every session's status, so it
      // degrades to "no pending" rather than failing the projection.
      const pending = yield* chatMessages.listPending.pipe(
        Effect.orElseSucceed(() => [] as ReadonlyArray<PendingRequest>),
      )
      const turns = yield* SubscriptionRef.get(openTurns)
      const pendingByTarget = new Map(pending.map((p) => [p.targetSessionId, p.kind]))
      return sessionList.map(
        (session): LiveTargetState => ({
          targetSessionId: session.id,
          chatId: session.chatId,
          activity: deriveActivity(session, pendingByTarget.get(session.id), turns),
        }),
      )
    })

    // Any of the three inputs changing re-derives the whole list. `void`-mapped
    // so the merge is a bare tick stream; `sessions.changes` (a SubscriptionRef)
    // replays its current value on subscribe, guaranteeing one initial emit even
    // though the chat-message PubSub does not replay.
    const tick = <A>(stream: Stream.Stream<A>): Stream.Stream<void> =>
      Stream.map(stream, () => undefined)
    const changes = Stream.mergeAll(
      [tick(sessions.changes), tick(chatMessages.changes), tick(SubscriptionRef.changes(openTurns))],
      { concurrency: "unbounded" },
    ).pipe(Stream.mapEffect(() => derive))

    const noteTurn = (targetSessionId: string, open: boolean) =>
      SubscriptionRef.update(openTurns, (set) => {
        if (open === set.has(targetSessionId)) return set // idempotent — no needless tick
        const next = new Set(set)
        if (open) next.add(targetSessionId)
        else next.delete(targetSessionId)
        return next
      })

    const clearTurn = (targetSessionId: string) => noteTurn(targetSessionId, false)

    return { list: derive, changes, noteTurn, clearTurn }
  }),
)
