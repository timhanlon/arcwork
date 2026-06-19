import type { JSX } from "react"
import { Button } from "@base-ui/react/button"
import type { Work } from "../../../shared/work.js"
import { isResolved } from "../work/work-status-display.js"
import { WorkStatusMarker } from "../work/WorkStatusMarker.js"
import { PriorityChip } from "../work/work-priority-controls.js"
import { ROW_ACTIVE, ROW_BASE, TREE_LABEL, TREE_MAIN, TREE_SUBTITLE } from "./row-styles.js"

/** How a work item relates to the chat it appears under in the tree. */
export type ChatWorkRelation = "authored" | "mentioned"

export interface WorkRowProps {
  readonly work: Work
  readonly relation: ChatWorkRelation
  readonly active: boolean
  readonly onSelect: () => void
}

/**
 * A leaf work row under a chat: status dot, title, optional priority chip, and a
 * faint "mentioned" subtitle when the unit was referenced here but authored
 * elsewhere.
 */
export function WorkRow({ work, relation, active, onSelect }: WorkRowProps): JSX.Element {
  const resolved = isResolved(work.status)
  return (
    <Button
      className={`${ROW_BASE} justify-start gap-[7px] ${active ? ROW_ACTIVE : ""}`}
      title={`${work.title} · ${work.status}${relation === "mentioned" ? " · mentioned" : ""} · ${work.id}`}
      onClick={onSelect}
    >
      <WorkStatusMarker status={work.status} />
      <span className={`${TREE_MAIN} min-w-0 flex-1`}>
        <span className={`${TREE_LABEL} ${resolved ? "text-fg-faint" : ""}`}>{work.title}</span>
        {relation === "mentioned" && <span className={TREE_SUBTITLE}>mentioned</span>}
      </span>
      {work.priority && (
        <span className="ml-auto flex-none">
          <PriorityChip priority={work.priority} />
        </span>
      )}
    </Button>
  )
}
