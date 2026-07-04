import { type JSX, useState } from "react"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { ChatId } from "../../../shared/ids.js"
import { answerAppServerApprovalAtom, appServerApprovalsAtom, successList } from "../atoms.js"
import { AppServerApproval } from "./AppServerApproval.js"

export interface ChatApprovalsProps {
  readonly chatId: ChatId
}

/**
 * The chat-scoped stack of codex app-server approvals awaiting an answer. An
 * app-server session has no PTY to defer the prompt to, so Arc owns the
 * interaction: this subscribes to the live `WatchAppServerApprovals` stream,
 * filters to this chat, and answers each by echoing a decision's `payload` back
 * verbatim. The list is ephemeral — an answered approval drops off the stream, so
 * there's nothing to clear here.
 */
export function ChatApprovals({ chatId }: ChatApprovalsProps): JSX.Element | null {
  const approvals = successList(useAtomValue(appServerApprovalsAtom)).filter((a) => a.chatId === chatId)
  const answer = useAtomSet(answerAppServerApprovalAtom, { mode: "promiseExit" })
  // requestIds currently in flight, keyed by their stringified id so the buttons
  // disable optimistically before the approval falls off the stream.
  const [answering, setAnswering] = useState<ReadonlySet<string>>(new Set())

  if (approvals.length === 0) return null

  return (
    <div className="grid gap-2 border-t border-border px-4 pb-3 pt-3">
      {approvals.map((approval) => {
        const key = String(approval.requestId)
        return (
          <AppServerApproval
            key={key}
            approval={approval}
            answering={answering.has(key)}
            onAnswer={(decisionPayload) => {
              setAnswering((prev) => new Set(prev).add(key))
              void answer({
                payload: {
                  targetSessionId: approval.targetSessionId,
                  requestId: approval.requestId,
                  decisionPayload,
                },
              }).finally(() => {
                setAnswering((prev) => {
                  const next = new Set(prev)
                  next.delete(key)
                  return next
                })
              })
            }}
          />
        )
      })}
    </div>
  )
}
