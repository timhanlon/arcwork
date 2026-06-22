import type { JSX } from "react"
import type { TargetId } from "../../../../shared/ids.js"
import type { TargetSession } from "../../../../shared/instance.js"
import { targetStatusDisplay } from "../session-status-display.js"
import { SessionDot } from "../../sidebar/SessionDot.js"
import { Chip } from "../../ui/Chip.js"
import { liveActivityFor, type LiveStateById } from "../../sidebar/grouping.js"

/** The composer's addressee line and per-target chips both name a session by its
 * provider. We only disambiguate when the provider alone is ambiguous — two
 * `claude`s in one chat become `claude 1` / `claude 2` by their order in the
 * chat. A lone provider (even alongside a different one) reads as just its name;
 * we never append the raw target id, which carries no meaning to a reader. */
export const formatAddressee = (
  session: TargetSession,
  sessionsInChat: ReadonlyArray<TargetSession>,
): string => {
  const sameProvider = sessionsInChat.filter((s) => s.provider === session.provider)
  if (sameProvider.length <= 1) return session.provider
  return `${session.provider} ${sameProvider.findIndex((s) => s.id === session.id) + 1}`
}

export interface ComposerTargetIndicatorsProps {
  /** every target session in the chat, in render order */
  readonly sessions: ReadonlyArray<TargetSession>
  /** session id → live activity, from the `arc:live-target-states` projection */
  readonly liveStateById: LiveStateById
  /** the session the composer would send to — gets the accent halo */
  readonly addresseeId?: string
  /** focus a session's terminal pane */
  readonly onFocusSession: (sessionId: TargetId) => void
  /** drop the status word, leaving just the dot + name — the dot's colour still
   * carries status, and the chip's title surfaces it on hover */
  readonly compact?: boolean
}

/**
 * The row of target-status chips under the composer's addressee line: one chip
 * per session in the chat, each pairing a {@link SessionDot} with its live
 * status word. The addressee chip wears the accent halo; waiting states add a
 * request ring. Every chip is a focus button, matching the workspace tree's
 * "select a target to show its terminal" behaviour.
 */
export function ComposerTargetIndicators(props: ComposerTargetIndicatorsProps): JSX.Element | null {
  const { sessions, liveStateById, addresseeId, onFocusSession, compact = false } = props
  if (sessions.length === 0) return null

  return (
    <div className="flex min-h-7 flex-wrap items-center gap-1.5">
      {sessions.map((session) => {
        const activity = liveActivityFor(session, liveStateById)
        const active = session.id === addresseeId
        const status = targetStatusDisplay(activity)
        const fullLabel = formatAddressee(session, sessions)
        // Compact strips the disambiguating short-id too — just the dot + bare
        // provider name; the hover title still carries the full label + status.
        const label = compact ? session.provider : fullLabel

        return (
          <Chip
            key={session.id}
            active={active}
            className={`h-7 max-w-full ${active ? "bg-accent/10 text-foreground" : "bg-background"} ${
              status.needsAttention
                ? "shadow-[0_0_0_1px_color-mix(in_srgb,var(--request)_28%,transparent)] enabled:hover:border-request focus-visible:ring-request"
                : "enabled:hover:border-accent focus-visible:ring-accent"
            }`}
            title={`Focus ${fullLabel}: ${status.label}`}
            onClick={() => onFocusSession(session.id)}
          >
            <SessionDot status={activity} />
            <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{label}</span>
            {!compact && <span className={`flex-none ${status.textTone}`}>{status.label}</span>}
          </Chip>
        )
      })}
    </div>
  )
}
