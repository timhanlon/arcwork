import { type JSX, useState } from "react"
import type { Work, WorkCommentListing, WorkPriority, WorkReviseInput, WorkStatus } from "../../../shared/work.js"
import { DETAIL_BODY, ERROR_BANNER } from "./styles.js"
import { WorkDetailBody } from "./WorkDetailBody.js"
import { WorkDetailEditor } from "./WorkDetailEditor.js"
import { WorkDetailHeader } from "./WorkDetailHeader.js"

export interface WorkDetailViewProps {
  readonly work: Work
  readonly busy?: boolean
  readonly error?: string
  /** Comments for this work, as `useWorkComments` returns them; omitted in stories
   * that only exercise the body/status surface. */
  readonly comments?: WorkCommentListing
  readonly commentsLoading?: boolean
  readonly showAllComments?: boolean
  readonly onToggleAllComments?: (v: boolean) => void
  readonly onBack: () => void
  readonly onStatus: (status: WorkStatus) => void
  readonly onPriority: (priority: WorkPriority) => void
  readonly onRevise: (edits: WorkReviseInput) => void
}

export function WorkDetailView(props: WorkDetailViewProps): JSX.Element {
  const {
    work,
    busy,
    error,
    comments,
    commentsLoading,
    showAllComments,
    onToggleAllComments,
    onBack,
    onStatus,
    onPriority,
    onRevise,
  } = props
  const [editing, setEditing] = useState(false)
  const [title, setTitle] = useState(work.title)
  const [body, setBody] = useState(work.body)
  const [labels, setLabels] = useState(work.labels.join(", "))

  const startEdit = (): void => {
    setTitle(work.title)
    setBody(work.body)
    setLabels(work.labels.join(", "))
    setEditing(true)
  }

  const saveEdit = (edits: WorkReviseInput): void => {
    onRevise(edits)
    setEditing(false)
  }

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col">
      <WorkDetailHeader
        work={work}
        busy={busy}
        editing={editing}
        onBack={onBack}
        onStartEdit={startEdit}
        onStatus={onStatus}
        onPriority={onPriority}
      />

      {error && <div className={ERROR_BANNER}>{error}</div>}

      {editing ? (
        // The editor owns its own scroll region + pinned action bar, so it sits
        // directly in the column rather than inside the `DETAIL_BODY` scroller.
        <WorkDetailEditor
          title={title}
          body={body}
          labels={labels}
          busy={busy}
          onTitle={setTitle}
          onBody={setBody}
          onLabels={setLabels}
          onCancel={() => setEditing(false)}
          onSave={saveEdit}
        />
      ) : (
        <div className={DETAIL_BODY}>
          <WorkDetailBody
            work={work}
            comments={comments}
            commentsLoading={commentsLoading}
            showAllComments={showAllComments}
            onToggleAllComments={onToggleAllComments}
          />
        </div>
      )}
    </div>
  )
}
