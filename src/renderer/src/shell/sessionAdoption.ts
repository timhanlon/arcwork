import type { TargetSession } from "../../../shared/instance.js"
import type { ShellPane } from "./arcShellMachine.js"

/**
 * Target sessions that exist in the live `arc:sessions` list but have no
 * terminal pane — the ones an MCP handoff (`arc_handoff_create`) launched
 * straight through `TargetSessionManager` without the renderer ever opening a
 * pane for them. A manual launch always opens its pane first (the renderer
 * drives it), so only out-of-band launches land here. These are "adopted" into
 * a background pane so a handoff-spawned implementer behaves like a manually
 * launched target: observable in the right terminal region, not just listed in
 * the sidebar.
 *
 * A session is adopted only when:
 *  - it is attached (this process holds a live PTY) and not exited — a
 *    detached/dead row is surfaced through the sidebar's resume affordance, not
 *    a live pane;
 *  - no pane already binds its id — it is already adopted, or a manual launch
 *    that has bound;
 *  - no *unbound* pane matches its `(provider, chatId)` — a manual launch in the
 *    gap between its pane opening (`TARGET_LAUNCH_REQUESTED`) and its session id
 *    binding (`TARGET_BOUND`). The session is broadcast the instant
 *    `TargetSessionManager.launch` writes the store, which can beat the launch
 *    rpc's response that binds the pane. This guard is only for manual/default
 *    sessions; orchestrated sessions can share a provider with the pending
 *    manual launch and still need their own pane.
 *
 * Pure and idempotent: once a session has been adopted it carries a bound pane,
 * so a later call excludes it — the App effect can run on every `arc:sessions`
 * push without re-opening panes.
 */
export function unadoptedSessions(
  sessions: ReadonlyArray<TargetSession>,
  panes: ReadonlyArray<ShellPane>,
): ReadonlyArray<TargetSession> {
  const boundIds = new Set<string>()
  const pendingKeys = new Set<string>()
  for (const pane of panes) {
    if (pane.sessionId) boundIds.add(pane.sessionId)
    else pendingKeys.add(`${pane.chatId}:${pane.provider}`)
  }
  return sessions.filter(
    (session) =>
      session.attached === true &&
      session.state !== "exited" &&
      !boundIds.has(session.id) &&
      ((session.origin ?? "manual") !== "manual" ||
        !pendingKeys.has(`${session.chatId}:${session.provider}`)),
  )
}
