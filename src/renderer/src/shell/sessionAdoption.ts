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
 *  - it was launched out-of-band — `origin === "orchestrated"`. A manual launch
 *    is renderer-driven: it opens its own pane at `TARGET_LAUNCH_REQUESTED`,
 *    before the session even exists, so it never needs adopting. The *only* time
 *    a manual session is attached-yet-paneless is the window right after its PTY
 *    exits, when its pane is already closed but the `arc:sessions` snapshot still
 *    reads `attached`/`running` (the exit event beats the state push over a
 *    separate channel). Adopting there re-opens a stray empty xterm over a dead
 *    session — and blocks resume, since a bound pane makes the resume flow reuse
 *    it instead of re-launching. Restricting to orchestrated sidesteps that race;
 *  - it is attached (this process holds a live PTY) and not exited — a
 *    detached/dead row is surfaced through the sidebar's resume affordance, not
 *    a live pane;
 *  - no pane already binds its id — it is already adopted.
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
  for (const pane of panes) {
    if (pane.sessionId) boundIds.add(pane.sessionId)
  }
  return sessions.filter(
    (session) =>
      session.origin === "orchestrated" &&
      session.attached === true &&
      session.state !== "exited" &&
      !boundIds.has(session.id),
  )
}
