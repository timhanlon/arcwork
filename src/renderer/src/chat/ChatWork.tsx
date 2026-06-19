import type { JSX } from "react"
import type { Work } from "../../../shared/work.js"
import { formatActivityDateTime, formatRelativeTime } from "./activity-event-display.js"
import { useShellActions } from "../shell/ShellActionsContext.js"
import { Button } from "../ui/Button.js"
import { PriorityChip } from "../work/work-priority-controls.js"
import { isResolved } from "../work/work-status-display.js"
import { WorkStatusMarker } from "../work/WorkStatusMarker.js"

/**
 * The chat-scoped work list — Stage 1 of making work visible inside arc. A boring
 * projection (per the document-graph proposal): status, title, labels, last
 * activity. Read-only for now; create/status/revise actions land next.
 *
 * Status maps to a colored dot + bucket. This is *authored* status
 * (open/active/blocked/done/superseded), deliberately not yet reconciled with
 * the derived queue lanes (needs_attention/running/…) — that decision is its own
 * tracked work item.
 */

export interface ChatWorkProps {
  readonly work: ReadonlyArray<Work>
}

export function ChatWork(props: ChatWorkProps): JSX.Element | null {
  const { work } = props
  const { open } = useShellActions()
  if (work.length === 0) return null

  return (
    <ol className="flex flex-col gap-1.5">
      {work.map((item) => {
        const resolved = isResolved(item.status)
        return (
          <li
            key={item.id}
            className="flex items-center gap-2 rounded-(--radius) text-[13px]"
          >
            {item.priority && <PriorityChip priority={item.priority} />}
            <Button
              variant="link"
              className={`flex items-center gap-1 min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
                resolved ? "text-fg-faint" : "text-foreground"
              }`}
              onClick={() => open({ kind: "work", workId: item.id }, "right")}
            >
              {item.title}
              <WorkStatusMarker status={item.status} title={item.status} />
            </Button>
            
            <time
              className="flex-none font-mono text-[11px] text-fg-faint tabular-nums"
              dateTime={item.updatedAt}
              title={formatActivityDateTime(item.updatedAt)}
            >
              {formatRelativeTime(item.updatedAt)}
            </time>
          </li>
        )
      })}
    </ol>
  )
}
