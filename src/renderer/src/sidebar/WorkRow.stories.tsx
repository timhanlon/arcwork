import type { ReactNode } from "react"
import { WorkRow } from "./WorkRow.js"
import { workItem } from "./fixtures.js"

export default {
  title: "Sidebar / WorkRow",
}

const noop = (): void => {}

/** Rows sit two levels deep in a ~252px column; frame matches session density. */
function Column({ children }: { readonly children: ReactNode }) {
  return <div style={{ width: 252, maxWidth: "100%", paddingLeft: 38 }}>{children}</div>
}

const base = workItem({
  id: "work_x",
  title: "Investigate hook attribution",
  status: "active",
  priority: "p1",
})

/** Authored vs mentioned, resolved, and priority variants. */
export const States = () => (
  <Column>
    <WorkRow work={base} relation="authored" active={false} onSelect={noop} />
    <WorkRow
      work={workItem({ id: "work_sel", title: "selected work item", status: "active", priority: "p1" })}
      relation="authored"
      active
      onSelect={noop}
    />
    <WorkRow
      work={workItem({ id: "work_men", title: "Referenced from another chat", status: "open" })}
      relation="mentioned"
      active={false}
      onSelect={noop}
    />
    <WorkRow
      work={workItem({ id: "work_done", title: "Shipped feature", status: "done" })}
      relation="authored"
      active={false}
      onSelect={noop}
    />
  </Column>
)
