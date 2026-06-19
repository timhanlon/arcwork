import type { TargetSession } from "../../../../shared/instance.js"
import type { LiveTargetActivity } from "../../../../shared/live-target-state.js"
import type { LiveStateById } from "../../sidebar/grouping.js"
import { ComposerTargetIndicators } from "./ComposerTargetIndicators.js"

export default {
  title: "Chat / ComposerTargetIndicators",
}

const session = (id: string, provider: string): TargetSession => ({
  _tag: "TargetSession",
  id,
  provider,
  chatId: "chat_demo",
  cwd: "/tmp/worktree",
  attached: true,
  state: "running",
  startedAt: "2026-06-12T00:00:00.000Z",
})

/** One chip per session, each labelled provider + short id (more than one in the
 * chat), so the chip wraps the full status vocabulary in context. */
/** The accent-haloed addressee in the stories below — named rather than
 * indexed out of `SESSIONS` so its non-undefined type is honest. */
const PRIMARY = session("target_01j9z8y7x6", "claude")

const SESSIONS: ReadonlyArray<TargetSession> = [
  PRIMARY,
  session("target_01j9y5w4v3", "codex"),
  session("target_01j9x2u1t0", "claude"),
  session("target_01j9w9s8r7", "codex"),
  session("target_01j9v6q5p4", "claude"),
  session("target_01j9u3n2m1", "codex"),
]

/** Pair each session with a distinct live activity so the story paints every
 * state: generating, the two waiting states, idle, exited, detached. */
const ACTIVITIES: ReadonlyArray<LiveTargetActivity> = [
  "generating",
  "waiting_for_input",
  "waiting_for_approval",
  "idle",
  "exited",
  "detached",
]

const liveStateById: LiveStateById = new Map(
  SESSIONS.map((s, i) => [s.id, ACTIVITIES[i] ?? "idle"]),
)

function Harness({ addresseeId, compact }: { addresseeId?: string; compact?: boolean }) {
  return (
    <div style={{ width: 460 }}>
      <ComposerTargetIndicators
        sessions={SESSIONS}
        liveStateById={liveStateById}
        addresseeId={addresseeId}
        onFocusSession={(id) => console.log("focus:", id)}
        compact={compact}
      />
    </div>
  )
}

/** Every status word, with the first ("active") session as the accent-haloed
 * addressee. Every chip focuses/switches to that target's terminal. */
export const AllStates = () => <Harness addresseeId={PRIMARY.id} />

/** Compact: just dot + target name. The dot's colour carries status (and the
 * chip title surfaces the word on hover); chips stay narrow when a chat holds
 * many targets. */
export const Compact = () => <Harness addresseeId={PRIMARY.id} compact />

/** Sole target in a chat: provider name alone (no short-id suffix), idle. */
export const SingleTarget = () => {
  const sole = session("target_01j9z8y7x6", "claude")
  return (
    <div style={{ width: 460 }}>
      <ComposerTargetIndicators
        sessions={[sole]}
        liveStateById={new Map([[sole.id, "idle"]])}
        addresseeId={sole.id}
        onFocusSession={(id) => console.log("focus:", id)}
      />
    </div>
  )
}
