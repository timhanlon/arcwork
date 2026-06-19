import type { ReactNode } from "react"
import { SessionRow } from "./SessionRow.js"
import { session, LIVE_ACTIVITIES } from "./fixtures.js"
import { sessionStatus } from "./grouping.js"

export default {
  title: "Sidebar / SessionRow",
}

const noop = (): void => {}

/** Rows sit two levels deep in a ~252px column; frame matches that density. */
function Column({ children }: { readonly children: ReactNode }) {
  return <div style={{ width: 252, maxWidth: "100%", paddingLeft: 38 }}>{children}</div>
}

/** Every live state, plus active and detached — the full row status matrix. */
export const AllStates = () => (
  <Column>
    <SessionRow
      session={session({ id: "target_active", chatId: "c", provider: "claude", preset: "opus" })}
      status="active"
      pending={false}
      active
      onSelect={noop}
    />
    {LIVE_ACTIVITIES.map((activity) => (
      <SessionRow
        key={activity}
        session={session({ id: `target_${activity}`, chatId: "c", provider: "codex" })}
        status={sessionStatus(activity, false)}
        pending={false}
        active={false}
        onSelect={noop}
      />
    ))}
  </Column>
)

/**
 * The trailing stop control (hover/focus to reveal). Offered only for attached
 * sessions; the detached row passes `onStop` too but renders no control.
 */
export const Stoppable = () => (
  <Column>
    <SessionRow
      session={session({ id: "target_run", chatId: "c", provider: "claude", preset: "opus", state: "running" })}
      status="generating"
      pending={false}
      active={false}
      onSelect={noop}
      onStop={noop}
    />
    <SessionRow
      session={session({ id: "target_wait", chatId: "c", provider: "codex", state: "waiting_for_input" })}
      status="waiting_for_input"
      pending
      active={false}
      onSelect={noop}
      onStop={noop}
    />
    <SessionRow
      session={session({ id: "target_det", chatId: "c", provider: "cursor", attached: false, state: "idle" })}
      status="detached"
      pending={false}
      active={false}
      onSelect={noop}
      onStop={noop}
    />
  </Column>
)

/**
 * A detached but resumable session gets a trailing play control (hover/focus to
 * reveal), the resume twin of the stop control. The non-resumable detached row
 * passes `onResume` too but renders no control.
 */
export const Resumable = () => (
  <Column>
    <SessionRow
      session={session({
        id: "target_res",
        chatId: "c",
        provider: "claude",
        preset: "opus",
        attached: false,
        resumable: true,
        state: "idle",
      })}
      status="detached"
      pending={false}
      active={false}
      onSelect={noop}
      onResume={noop}
    />
    <SessionRow
      session={session({ id: "target_nores", chatId: "c", provider: "codex", attached: false, state: "idle" })}
      status="detached"
      pending={false}
      active={false}
      onSelect={noop}
      onResume={noop}
    />
  </Column>
)

/** Waiting on the user — the pulsing trailing dot and request-toned status. */
export const Pending = () => (
  <Column>
    <SessionRow
      session={session({ id: "target_p", chatId: "c", provider: "claude", state: "waiting_for_input" })}
      status="waiting_for_input"
      pending
      active={false}
      onSelect={noop}
    />
  </Column>
)

/**
 * Waiting rows that carry a ⌘-number jump shortcut: the Phosphor ⌘ glyph + slot
 * sits before the pulsing pip and tells the user which key focuses this session.
 * Only the first nine waiting sessions get a slot; the tenth waits without one.
 */
export const PendingWithShortcut = () => (
  <Column>
    {[1, 2, 3].map((slot) => (
      <SessionRow
        key={slot}
        session={session({ id: `target_s${slot}`, chatId: "c", provider: "claude", state: "waiting_for_input" })}
        status="waiting_for_input"
        pending
        slot={slot}
        active={false}
        onSelect={noop}
      />
    ))}
    <SessionRow
      session={session({ id: "target_overflow", chatId: "c", provider: "codex", state: "waiting_for_approval" })}
      status="waiting_for_approval"
      pending
      active={false}
      onSelect={noop}
    />
  </Column>
)

/** With and without a preset subtitle. */
export const WithPreset = () => (
  <Column>
    <SessionRow
      session={session({ id: "target_wp", chatId: "c", provider: "claude", preset: "opus", state: "running" })}
      status="generating"
      pending={false}
      active={false}
      onSelect={noop}
    />
    <SessionRow
      session={session({ id: "target_np", chatId: "c", provider: "claude", state: "running" })}
      status="generating"
      pending={false}
      active={false}
      onSelect={noop}
    />
  </Column>
)

/** Long provider name — exercises the flex-1 ellipsis truncation. */
export const LongProvider = () => (
  <Column>
    <SessionRow
      session={session({
        id: "target_lp",
        chatId: "c",
        provider: "claude-code-experimental-preview-channel",
        preset: "an-unusually-long-preset-identifier",
        state: "running",
      })}
      status="generating"
      pending={false}
      active={false}
      onSelect={noop}
    />
  </Column>
)
