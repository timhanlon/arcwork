import type { ReactNode } from "react"
import type { AppServerApproval as AppServerApprovalData } from "../../../shared/codex-approval.js"
import { AppServerApproval } from "./AppServerApproval.js"

export default {
  title: "Chat / App-Server Approval",
}

// Approvals sit flat on the pane background, like the Question card.
const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 420, maxWidth: "100%" }}>{children}</div>
)

const noop = () => {}

const decision = (label: string, raw: unknown = label) => ({ label, payload: JSON.stringify(raw) })

// A read-only sandbox write: the common shell-exec approval.
const commandExec: AppServerApprovalData = {
  chatId: "chat_1",
  targetSessionId: "target_1",
  requestId: 501,
  approvalId: "appr_1",
  itemId: "call_lmCyiThzGf03OzBhckpeeMHB",
  command: "/bin/zsh -lc \"printf 'hi\\n' > spike.txt\"",
  decisions: [decision("accept"), decision("acceptForSession"), decision("cancel")],
}

// The rule-carrying decision the card must not collapse away.
const withExecpolicyAmendment: AppServerApprovalData = {
  ...commandExec,
  requestId: 502,
  decisions: [
    decision("accept"),
    decision("acceptWithExecpolicyAmendment", {
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["/bin/zsh", "-lc", "printf 'hi\\n' > spike.txt"] },
    }),
    decision("cancel"),
  ],
}

// A fileChange approval: no command, only an item + reason.
const fileChange: AppServerApprovalData = {
  chatId: "chat_1",
  targetSessionId: "target_1",
  requestId: "req-9",
  approvalId: null,
  itemId: "call_fileChange_7",
  command: null,
  decisions: [decision("accept"), decision("acceptForSession"), decision("decline")],
}

export const CommandExecution = () => (
  <Frame>
    <AppServerApproval approval={commandExec} onAnswer={noop} />
  </Frame>
)

export const WithExecpolicyAmendment = () => (
  <Frame>
    <AppServerApproval approval={withExecpolicyAmendment} onAnswer={noop} />
  </Frame>
)

export const FileChange = () => (
  <Frame>
    <AppServerApproval approval={fileChange} onAnswer={noop} />
  </Frame>
)

export const Answering = () => (
  <Frame>
    <AppServerApproval approval={commandExec} onAnswer={noop} answering />
  </Frame>
)
