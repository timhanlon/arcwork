import type { JSX } from "react"
import type { WorkCommentListing } from "../../../shared/work.js"
import { formatActivityDateTime, formatRelativeTime } from "../chat/activity-event-display.js"
import { Button } from "../ui/Button.js"
import { WorkMarkdown } from "./WorkMarkdown.js"
import { FIELD_LABEL } from "./styles.js"

export interface WorkCommentsProps {
  readonly listing: WorkCommentListing
  readonly loading?: boolean
  readonly showAll: boolean
  readonly onToggleAll?: (v: boolean) => void
}

/**
 * The comments attached to a unit of work, read-only. The default (current + ref)
 * view hides older-revision comments; a toggle reveals the full cross-revision
 * history. Each comment carries a quiet provenance line — "harness (model) via
 * source" — and its body.
 */
export function WorkComments(props: WorkCommentsProps): JSX.Element | null {
  const { listing, loading, showAll, onToggleAll } = props
  const { comments, olderRevisionCommentCount } = listing
  const hasOlder = olderRevisionCommentCount > 0

  // Nothing to show and nothing hidden: stay out of the way entirely.
  if (comments.length === 0 && !hasOlder) {
    return loading ? (
      <div className="flex flex-col gap-2 border-t border-border pt-2.5">
        <span className={FIELD_LABEL}>comments</span>
        <p className="m-0 text-[12px] text-fg-faint">loading…</p>
      </div>
    ) : null
  }

  return (
    <section className="flex flex-col gap-2 border-t border-border pt-2.5">
      <div className="flex items-center justify-between gap-2">
        <span className={FIELD_LABEL}>comments</span>
        {hasOlder && onToggleAll && (
          <Button variant="quiet" size="sm" onClick={() => onToggleAll(!showAll)}>
            {showAll
              ? "show current only"
              : `show ${olderRevisionCommentCount} on older revision${
                  olderRevisionCommentCount === 1 ? "" : "s"
                }`}
          </Button>
        )}
      </div>

      {comments.length === 0 ? (
        <p className="m-0 text-[12px] text-fg-faint">no comments on the current revision</p>
      ) : (
        <ul className="m-0 flex list-none flex-col gap-2.5 p-0">
          {comments.map((c) => (
              <li
                key={c.id}
                className="flex flex-col gap-1.5 rounded-[var(--radius)] border border-border bg-elev px-2.5 py-2"
              >
                <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 font-mono text-[11px] text-fg-faint">
                  {/* Provenance as one phrase: "harness (model) via source". The raw
                      session/chat ids are dropped as opaque noise; the full
                      provenance still lives on the work item itself. */}
                  {c.provenance.actor && <span>{c.provenance.actor}</span>}
                  <span>
                    {c.provenance.execution?.harness}
                    {c.provenance.execution?.model && ` (${c.provenance.execution.model})`}
                    {c.provenance.execution?.harness && " via "}
                    {c.provenance.source}
                  </span>
                  <time dateTime={c.createdAt} title={formatActivityDateTime(c.createdAt)}>
                    {formatRelativeTime(c.createdAt)}
                  </time>
                </div>
                <WorkMarkdown compact>{c.body}</WorkMarkdown>
              </li>
          ))}
        </ul>
      )}

      {/* When there is no toggle to act on (a read-only embedding), still surface
          the count so older-revision comments are never silently dropped. The
          toggle button above already carries this indicator when present. */}
      {!showAll && hasOlder && !onToggleAll && (
        <p className="m-0 text-[11px] text-fg-faint">
          +{olderRevisionCommentCount} comment{olderRevisionCommentCount === 1 ? "" : "s"} on older
          revisions
        </p>
      )}
    </section>
  )
}
