import { type JSX, useState } from "react"
import type { WorkCreateInput, WorkPriority, WorkStatus } from "../../../shared/work.js"
import { comboFor, matchesCombo } from "../shell/keybindings.js"
import { Button } from "../ui/Button.js"
import { Select } from "../ui/Select.js"
import { PrioritySelect } from "./work-priority-controls.js"
import { STATUS_OPTIONS } from "./work-status-display.js"
import {
  DETAIL_BODY,
  ERROR_BANNER,
  FIELD,
  FIELD_INPUT,
  FIELD_LABEL,
  FIELD_TEXTAREA,
  FORM_ACTIONS,
  HEADER,
  PANE_TITLE,
} from "./styles.js"
import { parseLabelsField } from "./utils.js"

export interface WorkCreateFormProps {
  readonly busy?: boolean
  readonly error?: string
  readonly onCancel: () => void
  readonly onCreate: (input: WorkCreateInput) => void
}

export function WorkCreateForm(props: WorkCreateFormProps): JSX.Element {
  const { busy, error, onCancel, onCreate } = props
  const [title, setTitle] = useState("")
  const [body, setBody] = useState("")
  const [labels, setLabels] = useState("")
  const [status, setStatus] = useState<WorkStatus>("open")
  const [priority, setPriority] = useState<WorkPriority | null>(null)

  const canSubmit = title.trim().length > 0 && !busy
  const submit = (): void => {
    if (!canSubmit) return
    onCreate({
      title: title.trim(),
      body,
      labels: parseLabelsField(labels),
      status,
      // Omit when unranked, so no priority_set edge is written.
      priority: priority ?? undefined,
    })
  }

  return (
    <>
      <header className={HEADER}>
        <h1 className={PANE_TITLE}>new work</h1>
      </header>

      {error && <div className={ERROR_BANNER}>{error}</div>}

      <div className={DETAIL_BODY}>
        <div className="flex flex-col gap-3">
          <label className={FIELD}>
            <span className={FIELD_LABEL}>title</span>
            <input
              className={FIELD_INPUT}
              autoFocus
              placeholder="what needs doing?"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (matchesCombo(e.nativeEvent, comboFor("submitWorkCreate"))) submit()
              }}
            />
          </label>
          <label className={FIELD}>
            <span className={FIELD_LABEL}>body</span>
            <textarea
              className={FIELD_TEXTAREA}
              rows={8}
              placeholder="context, reasoning, acceptance — markdown welcome"
              value={body}
              onChange={(e) => setBody(e.target.value)}
            />
          </label>
          <div className="grid grid-cols-[1fr_120px_120px] gap-3">
            <label className={FIELD}>
              <span className={FIELD_LABEL}>labels</span>
              <input
                className={FIELD_INPUT}
                placeholder="proposal, graph"
                value={labels}
                onChange={(e) => setLabels(e.target.value)}
              />
            </label>
            <div className={FIELD}>
              <span className={FIELD_LABEL}>status</span>
              <Select
                className="w-full"
                value={status}
                options={STATUS_OPTIONS}
                onValueChange={setStatus}
                aria-label="status"
              />
            </div>
            <div className={FIELD}>
              <span className={FIELD_LABEL}>priority</span>
              <PrioritySelect className="w-full" value={priority} onChange={setPriority} />
            </div>
          </div>
          <div className={FORM_ACTIONS}>
            <Button variant="quiet" size="sm" onClick={onCancel} disabled={busy}>
              cancel
            </Button>
            <Button size="sm" onClick={submit} disabled={!canSubmit}>
              create work
            </Button>
          </div>
        </div>
      </div>
    </>
  )
}
