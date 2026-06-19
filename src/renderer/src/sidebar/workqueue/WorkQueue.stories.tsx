import { useState } from "react"
import { WorkQueue } from "./WorkQueue.js"
import { workItemsFixture, REFERENCE_NOW } from "./fixtures.js"

export default {
  title: "Sidebar / WorkQueue",
}

/** Interactive: selection + archive remove rows so the queue re-sorts live. */
function Stateful({ width }: { width: number }) {
  const [items, setItems] = useState(workItemsFixture)
  const [active, setActive] = useState<string | undefined>(undefined)
  return (
    <div style={{ width, maxWidth: "100%", padding: 14 }}>
      <WorkQueue
        items={items}
        nowMs={REFERENCE_NOW}
        activeItemId={active}
        onSelect={setActive}
        onArchive={(id) => setItems((prev) => prev.filter((it) => it.id !== id))}
      />
    </div>
  )
}

/** Roomy panel — the queue is an inbox, not a cramped file tree. */
export const Default = () => <Stateful width={460} />

/** Constrained to the live 280px sidebar column, to pressure-test density. */
export const InSidebarColumn = () => <Stateful width={280} />

export const Empty = () => (
  <div style={{ width: 460, padding: 14 }}>
    <WorkQueue items={[]} nowMs={REFERENCE_NOW} />
  </div>
)

export const AttentionOnly = () => (
  <div style={{ width: 460, padding: 14 }}>
    <WorkQueue
      items={workItemsFixture.filter((it) => it.state === "needs_attention")}
      nowMs={REFERENCE_NOW}
    />
  </div>
)
