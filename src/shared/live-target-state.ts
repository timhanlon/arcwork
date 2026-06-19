import { Schema } from "effect"

/**
 * The *live* activity of a target session — what it is doing right now, for the
 * composer and sidebar status surfaces. This is deliberately NOT
 * {@link TargetSession.state} (instance.ts), which is lifecycle/persistence:
 * launch/resume writes `running`, exit writes `exited`, restore writes
 * `unknown`. "running there" only means a PTY is (or was) alive, never "actively
 * generating".
 *
 * Live activity is an *ephemeral* projection rebuilt each process from three
 * signals — PTY ownership, the hook turn lifecycle, and pending
 * questions/permissions — by `LiveTargetStateService`. It is never persisted.
 *
 * Precedence (highest first): a child that has `exited` or whose PTY this
 * process no longer holds (`detached`) is reported as such regardless of any
 * stale turn/pending signal; an attached child awaiting the user
 * (`waiting_for_approval` > `waiting_for_input`) beats one mid-turn
 * (`generating`); everything else is `idle`. So "generating" means a genuinely
 * open turn, not merely attached.
 */
export const LiveTargetActivity = Schema.Literals([
  "detached",
  "exited",
  "idle",
  "generating",
  "waiting_for_input",
  "waiting_for_approval",
])
export type LiveTargetActivity = typeof LiveTargetActivity.Type

/** One target session's live activity, keyed by `targetSessionId`. `chatId` is
 * carried so a consumer can fold per-chat without re-joining the session list. */
export const LiveTargetState = Schema.Struct({
  targetSessionId: Schema.String,
  chatId: Schema.String,
  activity: LiveTargetActivity,
})
export type LiveTargetState = typeof LiveTargetState.Type
