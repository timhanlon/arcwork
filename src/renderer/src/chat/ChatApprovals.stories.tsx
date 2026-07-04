import type { ReactNode } from "react"
import { RegistryProvider } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { AppServerApproval } from "../../../shared/codex-approval.js"
import type { ChatId } from "../../../shared/ids.js"
import { appServerApprovalsAtom } from "../atoms.js"
import { ChatApprovals } from "./ChatApprovals.js"

export default {
  title: "Chat / ChatApprovals",
}

const CHAT = "chat_demo" as ChatId
const OTHER = "chat_other" as ChatId

const shellApproval: AppServerApproval = {
  chatId: CHAT,
  targetSessionId: "target_demo",
  requestId: 7,
  approvalId: "appr_1",
  itemId: "item_cmd_1",
  command: "rm -rf node_modules && pnpm install",
  decisions: [
    { label: "accept", payload: JSON.stringify({ decision: "accept" }) },
    { label: "acceptForSession", payload: JSON.stringify({ decision: "acceptForSession" }) },
    { label: "cancel", payload: JSON.stringify({ decision: "cancel" }) },
  ],
}

const patchApproval: AppServerApproval = {
  chatId: CHAT,
  targetSessionId: "target_demo",
  requestId: "req-abc",
  approvalId: null,
  itemId: "item_patch_1",
  command: null,
  decisions: [
    { label: "accept", payload: JSON.stringify({ decision: "accept" }) },
    { label: "cancel", payload: JSON.stringify({ decision: "cancel" }) },
  ],
}

// An approval for a different chat — proves the container filters by chatId.
const otherChatApproval: AppServerApproval = {
  ...shellApproval,
  chatId: OTHER,
  requestId: 99,
  command: "should not appear",
}

function Frame({
  approvals,
  children,
}: {
  readonly approvals: ReadonlyArray<AppServerApproval>
  readonly children: ReactNode
}) {
  return (
    <RegistryProvider initialValues={[[appServerApprovalsAtom, AsyncResult.success(approvals)]]}>
      <div style={{ width: 520, maxWidth: "100%" }}>{children}</div>
    </RegistryProvider>
  )
}

/** A shell-command approval and a pty-less file-patch approval, both for this chat. */
export function Pending() {
  return (
    <Frame approvals={[shellApproval, patchApproval, otherChatApproval]}>
      <ChatApprovals chatId={CHAT} />
    </Frame>
  )
}

/** No approvals for this chat → the container renders nothing (the other chat's is filtered out). */
export function Empty() {
  return (
    <Frame approvals={[otherChatApproval]}>
      <div style={{ padding: 12, fontFamily: "monospace", fontSize: 12, opacity: 0.6 }}>
        (nothing renders below — no approvals for this chat)
      </div>
      <ChatApprovals chatId={CHAT} />
    </Frame>
  )
}
