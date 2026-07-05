import type { JSX } from "react"
import type { AppServerApproval as AppServerApprovalData } from "../../../shared/codex-approval.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"

const CARD = "grid gap-2.5 min-w-0"
const HEAD = "flex items-center justify-between gap-2"
const TITLE = "font-mono text-xs font-semibold text-foreground"
const COMMAND =
  "px-[7px] py-1 border border-border bg-input text-foreground font-mono text-[11px] leading-[1.35] whitespace-pre-wrap [overflow-wrap:anywhere]"
const PROMPT = "text-[13px] leading-[1.45] text-foreground [overflow-wrap:anywhere]"
const HINT = "font-mono text-[11px] text-fg-faint [overflow-wrap:anywhere]"

/**
 * Tone a decision button by its label. Unlike a PTY provider's own picker, this
 * card *is* the answer surface, so the affordances must read at a glance:
 * accept-family solid, cancel/decline danger, everything else (e.g.
 * acceptWithExecpolicyAmendment) a quieter ghost.
 */
const decisionVariant = (label: string): "solid" | "danger" | "ghost" => {
  const l = label.toLowerCase()
  if (l.startsWith("accept") || l === "approve" || l === "allow") return "solid"
  if (l === "cancel" || l === "decline" || l === "deny" || l === "reject") return "danger"
  return "ghost"
}

export interface AppServerApprovalProps {
  readonly approval: AppServerApprovalData
  /**
   * Answer the approval with a decision's `payload` (the raw server decision,
   * JSON-encoded). The container echoes it back verbatim via
   * `AnswerAppServerApproval` — the decision model is never collapsed.
   */
  readonly onAnswer?: (payload: string) => void
  /** Disable the buttons while an answer is in flight (optimistic). */
  readonly answering?: boolean
}

/**
 * A codex app-server approval awaiting an answer — the inline card that replaces
 * "focus the PTY and use the provider's picker" for the pty-less app-server path.
 * Renders the server-supplied decisions verbatim as buttons; there is no PTY to
 * defer to, so Arc owns the interaction.
 */
export function AppServerApproval({ approval, onAnswer, answering }: AppServerApprovalProps): JSX.Element {
  return (
    <div className={CARD}>
      <div className={HEAD}>
        <span className={TITLE}>approval</span>
        <Badge tone="neutral">awaiting answer</Badge>
      </div>
      {approval.command ? (
        <div className={COMMAND}>{approval.command}</div>
      ) : (
        <div className={PROMPT}>This action needs your approval.</div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {approval.decisions.map((decision) => (
          <Button
            key={decision.payload}
            variant={decisionVariant(decision.label)}
            disabled={answering}
            onClick={() => onAnswer?.(decision.payload)}
          >
            {decision.label}
          </Button>
        ))}
      </div>
      {approval.itemId && <span className={HINT}>{approval.itemId}</span>}
    </div>
  )
}
