import type { JSX, KeyboardEvent } from "react"
import type { WorkReviseInput } from "../../../shared/work.js"
import { comboFor, matchesCombo } from "../shell/keybindings.js"
import { Button } from "../ui/Button.js"
import { KbdShortcut } from "../ui/Kbd.js"
import { DETAIL_ACTIONS_BAR, DETAIL_EDIT_FIELDS, FIELD, FIELD_INPUT, FIELD_LABEL } from "./styles.js"
import { parseLabelsField } from "./utils.js"
import { WorkBodyEditor } from "./WorkBodyEditor.js"

export interface WorkDetailEditorProps {
  readonly title: string
  readonly body: string
  readonly labels: string
  readonly busy?: boolean
  readonly onTitle: (title: string) => void
  readonly onBody: (body: string) => void
  readonly onLabels: (labels: string) => void
  readonly onCancel: () => void
  readonly onSave: (edits: WorkReviseInput) => void
}

export function WorkDetailEditor(props: WorkDetailEditorProps): JSX.Element {
  const { title, body, labels, busy, onTitle, onBody, onLabels, onCancel, onSave } = props

  const canSave = !busy && title.trim().length > 0

  const saveEdit = (): void => {
    onSave({ title: title.trim(), body, labels: parseLabelsField(labels) })
  }

  // Esc / ⌘S fire from anywhere inside the editor — title, body, or labels — so
  // the listener sits on the root and reads the bubbled keydown. ⌘S must
  // preventDefault or the browser/Electron save dialog steals it.
  const onKeyDown = (e: KeyboardEvent): void => {
    if (matchesCombo(e.nativeEvent, comboFor("cancelWorkEdit"))) {
      e.preventDefault()
      onCancel()
    } else if (matchesCombo(e.nativeEvent, comboFor("saveWorkRevision"))) {
      e.preventDefault()
      if (canSave) saveEdit()
    }
  }

  return (
    // Own the full pane height: fields scroll, the action bar stays pinned below.
    // (The keydown listener sits here so Esc / ⌘S fire from the fields and the bar.)
    <div className="flex min-h-0 min-w-0 flex-1 flex-col" onKeyDown={onKeyDown}>
      <div className={DETAIL_EDIT_FIELDS}>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>title</span>
          <input className={FIELD_INPUT} value={title} onChange={(e) => onTitle(e.target.value)} />
        </label>
        <div className={FIELD}>
          <span className={FIELD_LABEL}>body</span>
          <WorkBodyEditor defaultMarkdown={body} onChange={onBody} />
        </div>
        <label className={FIELD}>
          <span className={FIELD_LABEL}>labels</span>
          <input
            className={FIELD_INPUT}
            placeholder="comma, separated"
            value={labels}
            onChange={(e) => onLabels(e.target.value)}
          />
        </label>
      </div>
      <div className={DETAIL_ACTIONS_BAR}>
        <Button variant="quiet" size="sm" onClick={onCancel} disabled={busy}>
          <span className="inline-flex items-center gap-1.5">
            cancel
            <KbdShortcut combo={comboFor("cancelWorkEdit")} />
          </span>
        </Button>
        <Button size="sm" onClick={saveEdit} disabled={!canSave}>
          <span className="inline-flex items-center gap-1.5">
            save revision
            <KbdShortcut combo={comboFor("saveWorkRevision")} />
          </span>
        </Button>
      </div>
    </div>
  )
}
