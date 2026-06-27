import type { JSX } from "react"
import type { Work, WorkCommentListing } from "../../../shared/work.js"
import { formatActivityDateTime } from "../chat/activity-event-display.js"
import { WorkMarkdown } from "./WorkMarkdown.js"
import { FIELD_LABEL, LABEL_CHIP } from "./styles.js"
import { WorkComments } from "./WorkComments.js"

export interface WorkDetailBodyProps {
  readonly work: Work
  readonly comments?: WorkCommentListing
  readonly commentsLoading?: boolean
  readonly showAllComments?: boolean
  readonly onToggleAllComments?: (v: boolean) => void
}

export function WorkDetailBody(props: WorkDetailBodyProps): JSX.Element {
  const { work, comments, commentsLoading, showAllComments, onToggleAllComments } = props

  return (
    <>
      {work.body.trim().length > 0 ? (
        <WorkMarkdown compact>{work.body}</WorkMarkdown>
      ) : (
        <p className="m-0 text-[13px] text-fg-faint">no description</p>
      )}

      {work.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {work.labels.map((label) => (
            <span key={label} className={LABEL_CHIP}>
              {label}
            </span>
          ))}
        </div>
      )}

      {work.citations.length > 0 && (
        <div className="flex flex-col gap-1.5">
          <span className={FIELD_LABEL}>citations</span>
          <ul className="flex flex-col gap-1">
            {work.citations.map((c) => (
              <li key={`${c.kind}:${c.target}`} className="text-[12px]">
                <div className="flex items-center gap-2">
                  <span className="flex-none rounded-[var(--radius)] border border-border px-1 font-mono text-[10px] uppercase tracking-[0.04em] text-fg-dim">
                    {c.kind}
                  </span>
                  <span className="break-all font-mono">{c.target}</span>
                </div>
                {c.note && <div className="text-[11px] text-fg-faint">{c.note}</div>}
              </li>
            ))}
          </ul>
        </div>
      )}

      <dl className="m-0 flex flex-col gap-[3px] border-t border-border pt-2.5">
        <div className="flex gap-2 text-[11px]">
          <dt className="w-14 flex-none font-mono uppercase tracking-[0.04em] text-fg-faint">source</dt>
          <dd className="m-0 text-fg-dim">{work.provenance.source}</dd>
        </div>
        {work.provenance.chatId && (
          <div className="flex gap-2 text-[11px]">
            <dt className="w-14 flex-none font-mono uppercase tracking-[0.04em] text-fg-faint">chat</dt>
            <dd className="m-0 font-mono text-fg-dim">{work.provenance.chatId}</dd>
          </div>
        )}
        {work.provenance.execution?.harness && (
          <div className="flex gap-2 text-[11px]">
            <dt className="w-14 flex-none font-mono uppercase tracking-[0.04em] text-fg-faint">harness</dt>
            <dd className="m-0 text-fg-dim">{work.provenance.execution.harness}</dd>
          </div>
        )}
        {work.provenance.execution?.model && (
          <div className="flex gap-2 text-[11px]">
            <dt className="w-14 flex-none font-mono uppercase tracking-[0.04em] text-fg-faint">model</dt>
            <dd className="m-0 text-fg-dim">{work.provenance.execution.model}</dd>
          </div>
        )}
        <div className="flex gap-2 text-[11px]">
          <dt className="w-14 flex-none font-mono uppercase tracking-[0.04em] text-fg-faint">created</dt>
          <dd className="m-0 text-fg-dim">{formatActivityDateTime(work.createdAt)}</dd>
        </div>
        <div className="flex gap-2 text-[11px]">
          <dt className="w-14 flex-none font-mono uppercase tracking-[0.04em] text-fg-faint">updated</dt>
          <dd className="m-0 text-fg-dim">{formatActivityDateTime(work.updatedAt)}</dd>
        </div>
      </dl>

      {comments && (
        <WorkComments
          listing={comments}
          loading={commentsLoading}
          showAll={showAllComments ?? false}
          onToggleAll={onToggleAllComments}
        />
      )}
    </>
  )
}
