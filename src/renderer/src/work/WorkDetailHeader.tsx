import type { JSX } from "react"
import type { Work, WorkPriority, WorkStatus } from "../../../shared/work.js"
import { Button } from "../ui/Button.js"
import { Select } from "../ui/Select.js"
import { PrioritySelect } from "./work-priority-controls.js"
import { STATUS_DOT, STATUS_OPTIONS } from "./work-status-display.js"
import {
  DETAIL_HEADER,
  DETAIL_TOP,
  FIELD_LABEL,
  HEADER_ACTIONS,
  WORK_DOT,
} from "./styles.js"
import { WorkIdCopy } from "./WorkIdCopy.js"

export interface WorkDetailHeaderProps {
  readonly work: Work
  readonly busy?: boolean
  readonly editing: boolean
  readonly onBack: () => void
  readonly onStartEdit: () => void
  readonly onStatus: (status: WorkStatus) => void
  readonly onPriority: (priority: WorkPriority) => void
}

export function WorkDetailHeader(props: WorkDetailHeaderProps): JSX.Element {
  const { work, busy, editing, onBack, onStartEdit, onStatus, onPriority } = props

  return (
    <div className={DETAIL_TOP}>
      <header className={DETAIL_HEADER}>
        <Button variant="quiet" size="sm" onClick={onBack}>
          ← back
        </Button>
        <div className={HEADER_ACTIONS}>
          {!editing && (
            <Button variant="ghost" size="sm" onClick={onStartEdit} disabled={busy}>
              edit
            </Button>
          )}
        </div>
      </header>

      <div className="flex flex-col gap-2 px-4 pb-3">
        <WorkIdCopy id={work.id} />

        {!editing && (
          <>
            <div className="flex items-center gap-2">
              <span
                className={WORK_DOT}
                style={{ backgroundColor: STATUS_DOT[work.status] }}
                aria-hidden
              />
              <h2 className="m-0 font-sans text-[16px] font-medium leading-[1.3]">{work.title}</h2>
            </div>

            <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
              <div className="flex items-center gap-2">
                <span className={FIELD_LABEL}>status</span>
                <Select
                  value={work.status}
                  options={STATUS_OPTIONS}
                  disabled={busy}
                  onValueChange={onStatus}
                  aria-label="status"
                />
              </div>

              <div className="flex items-center gap-2">
                <span className={FIELD_LABEL}>priority</span>
                <PrioritySelect
                  value={work.priority}
                  disabled={busy}
                  onChange={onPriority}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
