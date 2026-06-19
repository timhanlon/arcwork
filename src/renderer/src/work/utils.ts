import type { WorkStatus } from "../../../shared/work.js"
import { WORK_STATUSES } from "./work-status-display.js"

/** A status filter tab — the five statuses plus an "all" catch-all. */
export type StatusTab = WorkStatus | "all"

export const STATUS_TABS: ReadonlyArray<StatusTab> = [
  "open",
  ...WORK_STATUSES.filter((s) => s !== "open"),
  "all",
]

/** Split a free-text labels field ("bug, graph") into a clean label set. */
export const parseLabelsField = (raw: string): ReadonlyArray<string> =>
  raw
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0)

export const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))
