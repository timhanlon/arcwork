import { type JSX, useMemo, useState } from "react"
import { useAllWork } from "./useAllWork.js"
import { useWorkComments } from "./useWorkComments.js"
import { WorkCreateForm } from "./WorkCreateForm.js"
import { WorkDetailView } from "./WorkDetailView.js"
import { WorkListView } from "./WorkListView.js"
import { useWorkPaneMutations } from "./useWorkPaneMutations.js"
import type { StatusTab } from "./utils.js"

/**
 * The work navigator — the dedicated Work view. Lists every unit of work in the
 * selected chat's workspace, filters by status, and lets you author work and move
 * it through its lifecycle without asking an agent: the same `WorkService` the
 * MCP work tools use, reached over the RPC seam.
 *
 * Pure views live under `work/` and take props; this container owns the data
 * (`useAllWork`) and mutations (`useWorkPaneMutations`). The views carry no
 * transport, so they story with fixtures.
 */

export type { WorkCommentsProps } from "./WorkComments.js"
export type { WorkCreateFormProps } from "./WorkCreateForm.js"
export type { WorkDetailViewProps } from "./WorkDetailView.js"
export type { WorkListViewProps } from "./WorkListView.js"
export { WorkComments } from "./WorkComments.js"
export { WorkCreateForm } from "./WorkCreateForm.js"
export { WorkDetailView } from "./WorkDetailView.js"
export { WorkListView } from "./WorkListView.js"

export interface WorkPaneProps {
  readonly chatId?: string
  /** The selected work item — controlled by the shell machine, so the pick
   * survives a surface switch and is shared across the center/right regions. */
  readonly selectedId?: string
  /** Select a work item (`id`) or deselect back to the list (`undefined`). */
  readonly onSelectWork?: (workId: string | undefined) => void
}

// `h-full` fills the bounded resizable Panel so the inner flex chain
// (min-h-0 + flex-1) can establish internal scroll regions — otherwise the
// section grows to content and the whole pane scrolls, leaving nothing for the
// detail editor's action bar to pin against.
const PANE_SHELL = "flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-background"

export function WorkPane({ chatId, selectedId, onSelectWork }: WorkPaneProps = {}): JSX.Element {
  const { work, loading, reload } = useAllWork(chatId)
  const [tab, setTab] = useState<StatusTab>("open")
  const [creating, setCreating] = useState(false)

  const { busy, error, setError, create, changeStatus, changePriority, revise } = useWorkPaneMutations({
    reload,
    chatId,
    onCreated: (made) => {
      setCreating(false)
      setTab(made.status)
      onSelectWork?.(made.id)
    },
  })

  const counts = useMemo(() => {
    const map: Record<StatusTab, number> = {
      all: work.length,
      open: 0,
      active: 0,
      blocked: 0,
      done: 0,
      superseded: 0,
    }
    for (const w of work) map[w.status] += 1
    return map
  }, [work])

  const visible = useMemo(
    () => (tab === "all" ? work : work.filter((w) => w.status === tab)),
    [work, tab],
  )

  const selected = selectedId ? work.find((w) => w.id === selectedId) : undefined
  const comments = useWorkComments(selected?.id)

  if (creating) {
    return (
      <section className={PANE_SHELL}>
        <WorkCreateForm
          busy={busy}
          error={error}
          onCancel={() => {
            setCreating(false)
            setError(undefined)
          }}
          onCreate={create}
        />
      </section>
    )
  }

  if (selected) {
    return (
      <section className={PANE_SHELL}>
        <WorkDetailView
          work={selected}
          busy={busy}
          error={error}
          comments={comments.listing}
          commentsLoading={comments.loading}
          showAllComments={comments.allRevisions}
          onToggleAllComments={comments.setAllRevisions}
          onBack={() => {
            setError(undefined)
            onSelectWork?.(undefined)
          }}
          onStatus={(status) => changeStatus(selected.id, status)}
          onPriority={(priority) => changePriority(selected.id, priority)}
          onRevise={(edits) => revise(selected.id, edits)}
        />
      </section>
    )
  }

  return (
    <section className={PANE_SHELL}>
      <WorkListView
        work={visible}
        counts={counts}
        tab={tab}
        loading={loading}
        error={error}
        onTab={setTab}
        onSelect={(w) => {
          setError(undefined)
          onSelectWork?.(w.id)
        }}
        onNew={() => {
          setCreating(true)
          setError(undefined)
        }}
        onRefresh={reload}
      />
    </section>
  )
}
