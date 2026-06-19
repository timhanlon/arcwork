/**
 * Work-queue view model.
 *
 * This is a *projection*, not a stored entity. Today it is hand-authored in
 * `fixtures.ts`; later it will be derived in the main process from sessions +
 * chats + reconciled git/PR state. The presentational `WorkQueue` component only
 * ever knows `WorkItem` — so when the backend lands, nothing in the UI changes.
 *
 * Mirror the lifecycle table in
 * `docs/proposals/2026-06-06-sidebar-work-queue.md` exactly: doc and code stay
 * in sync because they share these names.
 */

/** Lifecycle state that drives the row's bucket, dot color, and sort priority. */
export type WorkState =
  | "needs_attention" // blocked on user, CI/tests failed, or review requested
  | "running" // agent actively working or a command in progress
  | "waiting" // idle but not done; the next action is external
  | "complete" // final answer produced, no known failing check
  | "stale" // no meaningful activity for a configured interval

/** Linked pull request, when one has been resolved for this item. */
export interface WorkItemPr {
  readonly number: number
  readonly state: "open" | "merged" | "closed"
}

/** One row in the queue: a chat's worth of work, projected to what the eye needs. */
export interface WorkItem {
  readonly id: string
  readonly title: string
  /** Visible project/repo column — metadata, never a group header. */
  readonly project: string
  /** Owning agent, e.g. "claude", "codex", "desktop". */
  readonly agent: string
  readonly state: WorkState
  /** Short human phrase: "tests failed", "needs user", "PR open", "merged". */
  readonly detail: string
  /** ISO timestamp of last *meaningful* activity — drives "4m ago" + sort. */
  readonly lastActivityAt: string
  readonly pr?: WorkItemPr
  readonly branch?: string
}
