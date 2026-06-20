import type { JSX } from "react"
import { Button } from "@base-ui/react/button"
import { PlayIcon, StopIcon } from "@phosphor-icons/react"
import type { TargetSession } from "../../../shared/instance.js"
import { targetStatusDisplay } from "../chat/session-status-display.js"
import { SessionDot } from "./SessionDot.js"
import { KeyHint } from "../ui/KeyHint.js"
import { ROW_BASE, SESSION_ACTIVE, TREE_LABEL, TREE_MAIN, TREE_SUBTITLE, type SessionDisplayStatus } from "./row-styles.js"

export interface SessionRowProps {
  readonly session: TargetSession
  readonly status: SessionDisplayStatus
  /** a target-originated request on this session still awaits the user */
  readonly pending: boolean
  /** ⌘/Ctrl + this number jumps here; shown as a hint while pending (1–9) */
  readonly slot?: number
  /** this session owns the focused pane */
  readonly active: boolean
  readonly onSelect: () => void
  /** stop this session's live process; only offered when it's attached */
  readonly onStop?: () => void
  /** re-attach this session; only offered when it's detached and resumable */
  readonly onResume?: () => void
}

// The trailing stop/resume control overlaid on a session row: a small square
// glyph button revealed on row hover/focus. Shared so the two only differ by
// their hover tone (stop → request red, resume → accent) and their icon.
const SESSION_OVERLAY =
  "absolute right-1.5 top-1/2 flex size-[18px] -translate-y-1/2 cursor-pointer items-center justify-center rounded-[var(--radius)] border-0 bg-transparent p-0 text-fg-faint opacity-0 hover:bg-elev focus-visible:opacity-100 focus-visible:outline-none group-hover:opacity-100"

/**
 * A leaf session row: status dot, provider (+ optional preset subtitle), and a
 * pulsing trailing dot when the target is waiting on the user. Pure and
 * prop-driven — the tree decides status/pending/active and passes them in.
 *
 * An attached session (this process holds its live PTY) also gets a trailing
 * stop control, revealed on hover/focus, that signals the child to terminate;
 * a detached-but-resumable one gets a resume control in the same slot instead.
 */
export function SessionRow({ session, status, pending, slot, active, onSelect, onStop, onResume }: SessionRowProps): JSX.Element {
  const canStop = onStop !== undefined && session.attached === true
  const canResume = onResume !== undefined && session.attached !== true && session.resumable === true
  const statusLabel = targetStatusDisplay(status).label
  return (
    // `group` + `relative` so the stop control can overlay the row's trailing
    // edge without nesting a <button> inside the row's select <button>.
    <div className="group relative min-w-0">
      <Button
        className={`${ROW_BASE} justify-start gap-[7px] ${active ? SESSION_ACTIVE : ""}`}
        title={
          pending
            ? `${session.provider} · waiting for your answer${slot ? ` · ⌘${slot}` : ""} · ${session.id}`
            : `${session.provider} · ${statusLabel} · ${session.id}`
        }
        onClick={onSelect}
      >
        <SessionDot status={status} />
        <span className={TREE_MAIN}>
          <span className={`${TREE_LABEL} text-fg-dim`}>{session.provider}</span>
          {session.preset && <span className={TREE_SUBTITLE}>{session.preset}</span>}
        </span>
        {pending && (
          // Shortcut hint + pulsing pip, hidden on hover so the stop control can
          // take the trailing edge. The hint tells the user which ⌘-number jumps
          // here without opening any cheatsheet.
          <span className="ml-auto flex flex-none items-center gap-1.5 group-hover:invisible">
            {slot !== undefined && <KeyHint slot={slot} />}
            <span
              className="size-1.5 rounded-full bg-request shadow-[0_0_0_2px_color-mix(in_srgb,var(--request)_28%,transparent)] animate-[session-pending-pulse_1.6s_ease-in-out_infinite] motion-reduce:animate-none"
              aria-label="waiting for your answer"
            />
          </span>
        )}
      </Button>
      {canStop && (
        <Button
          className={`${SESSION_OVERLAY} hover:text-request`}
          title={`Stop ${session.provider} session`}
          aria-label={`Stop ${session.provider} session`}
          onClick={(e) => {
            // Don't let the stop click bubble to the row's select handler.
            e.stopPropagation()
            onStop?.()
          }}
        >
          <StopIcon size={11} weight="fill" />
        </Button>
      )}
      {canResume && (
        <Button
          className={`${SESSION_OVERLAY} hover:text-accent`}
          title={`Resume ${session.provider} session`}
          aria-label={`Resume ${session.provider} session`}
          onClick={(e) => {
            // Don't let the resume click bubble to the row's select handler.
            e.stopPropagation()
            onResume?.()
          }}
        >
          <PlayIcon size={11} weight="fill" />
        </Button>
      )}
    </div>
  )
}
