import type { JSX } from "react"
import type { PaneId, TargetId } from "../../../shared/ids.js"
import type { TargetSession } from "../../../shared/instance.js"
import { bindingFor } from "../shell/keybindings.js"
import { Button } from "../ui/Button.js"
import { KbdShortcut } from "../ui/Kbd.js"
import { TerminalSurface } from "../terminal/Terminal.js"

const RESUME_BINDING = bindingFor("resumeDetachedSession")

export interface TargetSessionPanePane {
  readonly id: string
  readonly sessionId?: TargetId
  readonly resumeSessionId?: TargetId
}

export interface TargetSessionPaneProps {
  readonly panes: ReadonlyArray<TargetSessionPanePane>
  readonly activePaneId?: PaneId
  readonly detachedSession?: TargetSession
  readonly hasWorkspaces: boolean
  readonly onResumeDetached: () => void
  /** Whether the detached session's provider can resume into the app-server (rpc)
   * runtime — offers a second, terminal-less resume that lands in the chat pane. */
  readonly canResumeRpc?: boolean
  readonly onResumeDetachedRpc?: () => void
}

export function TargetSessionPane(props: TargetSessionPaneProps): JSX.Element {
  const { panes, activePaneId, detachedSession, hasWorkspaces, onResumeDetached } = props

  const detachedOverlay = detachedSession ? (
    <div className="empty detached-session">
      {detachedSession.resumable ? (
        <div className="inline-flex items-center gap-2">
          <Button
            className="inline-flex items-center gap-1.5"
            onClick={onResumeDetached}
            aria-label={`Resume ${detachedSession.provider} session${RESUME_BINDING ? ` (${RESUME_BINDING.label})` : ""}`}
            title={`Resume ${detachedSession.provider} session${RESUME_BINDING ? ` (${RESUME_BINDING.label})` : ""}`}
          >
            resume {detachedSession.provider}
          </Button>
          {RESUME_BINDING && <KbdShortcut combo={RESUME_BINDING.combo} />}
          {props.canResumeRpc && (
            <Button
              variant="ghost"
              className="inline-flex items-center gap-1.5"
              onClick={props.onResumeDetachedRpc}
              aria-label={`Resume ${detachedSession.provider} in the app-server runtime`}
              title={`Resume ${detachedSession.provider} in the app-server runtime (no terminal)`}
            >
              resume {detachedSession.provider} · app-server
            </Button>
          )}
        </div>
      ) : (
        <div className="dim">{detachedSession.provider} session is not resumable</div>
      )}
    </div>
  ) : null

  return (
    <section className="target-pane pane">
      {panes.length > 0 ? (
        <div className="term-stack">
          {/* The active pane's xterm host is reparented into the surface slot by
              the terminal registry; passing no active id while detached parks all
              terminals so the overlay shows over a quiet surface. */}
          <TerminalSurface activePaneId={detachedSession ? undefined : activePaneId} />
          {detachedOverlay}
        </div>
      ) : detachedSession ? (
        detachedOverlay
      ) : hasWorkspaces ? (
        <div className="empty">select or launch a target session</div>
      ) : (
        <div className="empty dim">open a workspace to begin</div>
      )}
    </section>
  )
}
