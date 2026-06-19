import type { WorkItem } from "./types.js"

/**
 * Fixed "now" anchor. All `lastActivityAt` values below are offsets from this,
 * so relative labels ("4m ago") render identically every run. When the backend
 * adapter replaces these fixtures, drop this and use real timestamps.
 */
export const REFERENCE_NOW = Date.parse("2026-06-06T15:00:00Z")

const minutesAgo = (n: number): string => new Date(REFERENCE_NOW - n * 60_000).toISOString()
const hoursAgo = (n: number): string => minutesAgo(n * 60)
const daysAgo = (n: number): string => minutesAgo(n * 60 * 24)

/**
 * Hand-authored rows covering every bucket and the edge cases worth designing
 * against: a failed-tests row, a review-requested row, a merged PR, a long-stale
 * quiet spike. Make this rich enough to stress the layout.
 */
export const workItemsFixture: ReadonlyArray<WorkItem> = [
  {
    id: "wi_checkout_race",
    title: "Fix checkout race condition",
    project: "storefront",
    agent: "claude",
    state: "needs_attention",
    detail: "tests failed",
    lastActivityAt: minutesAgo(4),
    branch: "fix-checkout-race",
    pr: { number: 482, state: "open" },
  },
  {
    id: "wi_sidebar_archive",
    title: "Review sidebar archive behavior",
    project: "electron-app",
    agent: "codex",
    state: "needs_attention",
    detail: "needs user",
    lastActivityAt: minutesAgo(12),
  },
  {
    id: "wi_pr_autoarchive",
    title: "Add PR close auto-archive rule",
    project: "electron-app",
    agent: "desktop",
    state: "running",
    detail: "running",
    lastActivityAt: minutesAgo(1),
    branch: "auto-archive-rule",
  },
  {
    id: "wi_status_model",
    title: "Refactor session status model",
    project: "electron-app",
    agent: "claude",
    state: "running",
    detail: "coding",
    lastActivityAt: minutesAgo(9),
  },
  {
    id: "wi_handoff_perms",
    title: "Wire task-handoff permission prompt",
    project: "electron-app",
    agent: "codex",
    state: "waiting",
    detail: "awaiting review",
    lastActivityAt: minutesAgo(38),
    branch: "handoff-perms",
    pr: { number: 477, state: "open" },
  },
  {
    id: "wi_task_handoff_docs",
    title: "Update docs for task handoff",
    project: "docs-site",
    agent: "claude",
    state: "complete",
    detail: "done",
    lastActivityAt: hoursAgo(2),
    branch: "handoff-docs",
    pr: { number: 471, state: "merged" },
  },
  {
    id: "wi_sort_spike",
    title: "Spike sidebar sorting options",
    project: "electron-app",
    agent: "claude",
    state: "stale",
    detail: "quiet",
    lastActivityAt: daysAgo(1),
  },
  {
    id: "wi_ingest_audit",
    title: "Audit event ordering",
    project: "pipeline",
    agent: "codex",
    state: "stale",
    detail: "no activity 6d",
    lastActivityAt: daysAgo(6),
  },
]
