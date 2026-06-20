import type { JSX } from "react"
import type { Work } from "../../../shared/work.js"
import { formatActivityDateTime, formatRelativeTime } from "../chat/activity-event-display.js"
import { Button } from "../ui/Button.js"
import { Row } from "../ui/Row.js"
import { Chip } from "../ui/Chip.js"
import { KbdShortcut } from "../ui/Kbd.js"
import { comboFor } from "../shell/keybindings.js"
import { PriorityChip } from "./work-priority-controls.js"
import { isResolved } from "./work-status-display.js"
import { WorkStatusMarker } from "./WorkStatusMarker.js"
import { ERROR_BANNER, HEADER, HEADER_ACTIONS, PANE_TITLE } from "./styles.js"
import { STATUS_TABS, type StatusTab } from "./utils.js"

export interface WorkListViewProps {
  readonly work: ReadonlyArray<Work>
  readonly counts: Record<StatusTab, number>
  readonly tab: StatusTab
  readonly loading?: boolean
  readonly error?: string
  readonly onTab: (tab: StatusTab) => void
  readonly onSelect: (work: Work) => void
  readonly onNew: () => void
}

export function WorkListView(props: WorkListViewProps): JSX.Element {
  const { work, counts, tab, loading, error, onTab, onSelect, onNew } = props
  return (
    <>
      <header className={HEADER}>
        <h1 className={PANE_TITLE}>work</h1>
        <div className={HEADER_ACTIONS}>
          <Button size="sm" onClick={onNew}>
            <span className="inline-flex items-center gap-1.5">
              + new work
              <KbdShortcut combo={comboFor("createWork")} />
            </span>
          </Button>
        </div>
      </header>

      <nav
        className="flex flex-none flex-wrap gap-1 border-b border-border px-4 py-2.5"
        aria-label="Filter work by status"
      >
        {STATUS_TABS.map((t) => {
          const active = t === tab
          return (
            <Chip
              key={t}
              active={active}
              className={`focus-visible:ring-accent ${
                active ? "text-accent" : "enabled:hover:border-border-strong enabled:hover:text-foreground"
              }`}
              onClick={() => onTab(t)}
            >
              {t}
              <span className={`text-[10px] ${active ? "text-accent" : "text-fg-faint"}`}>
                {counts[t]}
              </span>
            </Chip>
          )
        })}
      </nav>

      {error && <div className={ERROR_BANNER}>{error}</div>}

      <div className="min-h-0 flex-1 overflow-y-auto px-3 py-2">
        {work.length === 0 ? (
          <p className="px-1 py-3 text-[13px] text-fg-faint">
            {loading ? "loading…" : `no ${tab === "all" ? "" : `${tab} `}work`}
          </p>
        ) : (
          <ol className="flex flex-col gap-0.5">
            {work.map((item) => {
              const resolved = isResolved(item.status)
              return (
                <li key={item.id}>
                  <Row className="gap-2 text-[13px]" onClick={() => onSelect(item)}>
                    <WorkStatusMarker status={item.status} title={item.status} />
                    {item.priority && <PriorityChip priority={item.priority} />}
                    <span
                      className={`min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap ${
                        resolved ? "text-fg-faint" : ""
                      }`}
                    >
                      {item.title}
                    </span>
                    <time
                      className="flex-none font-mono text-[11px] text-fg-faint tabular-nums"
                      dateTime={item.updatedAt}
                      title={formatActivityDateTime(item.updatedAt)}
                    >
                      {formatRelativeTime(item.updatedAt)}
                    </time>
                  </Row>
                </li>
              )
            })}
          </ol>
        )}
      </div>
    </>
  )
}
