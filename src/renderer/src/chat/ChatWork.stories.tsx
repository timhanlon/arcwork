import type { Work, WorkPriority } from "../../../shared/work.js"
import { ChatWork } from "./ChatWork.js"
import { WORK_STATUSES } from "../work/work-status-display.js"

export default {
  title: "Chat / ChatWork",
}

const REFERENCE_NOW = "2026-06-07T17:00:00.000Z"

function work(
  partial: Pick<Work, "id" | "title" | "status" | "labels" | "updatedAt"> & {
    readonly priority?: WorkPriority
  },
): Work {
  return {
    _tag: "Work",
    nodeId: `${partial.id}_rev`,
    body: "",
    createdAt: REFERENCE_NOW,
    provenance: { source: "cli" },
    citations: [],
    ...partial,
    priority: partial.priority ?? null,
  }
}

/** One item per status, so the resolved rows (check-square, dimmed title) and the
 * plain in-flight rows are all visible at once. */
const items: ReadonlyArray<Work> = WORK_STATUSES.map((status, i) =>
  work({
    id: `work_${status}`,
    title: `Migrate the ${status} pane to Tailwind utilities`,
    status,
    labels: i % 2 === 0 ? ["renderer", "tailwind"] : ["proposal"],
    updatedAt: `2026-06-07T1${6 - i}:30:00.000Z`,
    // A ranked item or two so the priority chip is visible alongside the dot.
    ...(i === 0 ? { priority: "p0" as const } : i === 2 ? { priority: "p2" as const } : {}),
  }),
)

/** Chat pane is a narrow column; render in one to pressure-test title ellipsis. */
function Column({ children }: { children: React.ReactNode }) {
  return <div style={{ width: 380, maxWidth: "100%" }}>{children}</div>
}

export const Default = () => (
  <Column>
    <ChatWork work={items} />
  </Column>
)

/** A single open item — the common case for a young chat. */
export const SingleItem = () => (
  <Column>
    <ChatWork
      work={[work({ id: "work_1", title: "Investigate hook attribution", status: "open", labels: ["bug"], updatedAt: REFERENCE_NOW })]}
    />
  </Column>
)

/** Long title with no labels — exercises the flex-1 ellipsis truncation. */
export const LongTitle = () => (
  <Column>
    <ChatWork
      work={[
        work({
          id: "work_long",
          title:
            "Reconcile authored work status vs the derived queue lane state so the two surfaces never drift",
          status: "active",
          labels: [],
          updatedAt: REFERENCE_NOW,
        }),
      ]}
    />
  </Column>
)
