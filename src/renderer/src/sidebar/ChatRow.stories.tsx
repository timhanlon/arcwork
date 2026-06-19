import type { ReactNode } from "react"
import { CaretDown } from "@phosphor-icons/react"
import { ChatRow } from "./ChatRow.js"
import { chat } from "./fixtures.js"
import { DISCLOSURE } from "./row-styles.js"

export default {
  title: "Sidebar / ChatRow",
}

const noop = (): void => {}

/** Static stand-in for the live Collapsible.Trigger so the row reads complete. */
const chevron = (
  <span className={DISCLOSURE} aria-hidden>
    <CaretDown size={12} weight="bold" />
  </span>
)

/** Chat rows sit one level deep under a workspace — frame matches that indent. */
function Column({ children }: { readonly children: ReactNode }) {
  return <div style={{ width: 252, maxWidth: "100%", paddingLeft: 18 }}>{children}</div>
}

const base = chat({ id: "chat_x", workspaceId: "w", title: "investigate hook attribution" })

/** The badge/selection matrix: plain, selected, with sessions, awaiting input. */
export const States = () => (
  <Column>
    <ChatRow chat={base} selected={false} sessionCount={0} pendingCount={0} onSelect={noop} disclosure={chevron} />
    <ChatRow chat={chat({ ...base, id: "chat_sel", title: "selected chat" })} selected sessionCount={3} pendingCount={0} onSelect={noop} disclosure={chevron} />
    <ChatRow chat={chat({ ...base, id: "chat_cnt", title: "with sessions" })} selected={false} sessionCount={4} pendingCount={0} onSelect={noop} disclosure={chevron} />
    <ChatRow chat={chat({ ...base, id: "chat_pend", title: "waiting on you" })} selected={false} sessionCount={2} pendingCount={1} onSelect={noop} disclosure={chevron} />
  </Column>
)

/** Long title with both badges — exercises ellipsis against the trailing chips. */
export const LongTitle = () => (
  <Column>
    <ChatRow
      chat={chat({ id: "chat_long", workspaceId: "w", title: "reconcile authored work status vs the derived queue lane state so the two surfaces never drift" })}
      selected={false}
      sessionCount={5}
      pendingCount={2}
      onSelect={noop}
      disclosure={chevron}
    />
  </Column>
)
