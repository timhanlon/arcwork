import type { ActivityEvent } from "../../../shared/activity-event.js"
import { tildify } from "../format-path.js"

export interface ActivityEventLine {
  readonly title: string
  readonly detail?: string
}

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

export const formatActivityEvent = (event: ActivityEvent): ActivityEventLine => {
  const payload = event.payload

  switch (event.kind) {
    case "target.turn.started": {
      const prompt = str(payload.prompt)
      return { title: "Turn started", detail: prompt }
    }
    case "target.turn.ended": {
      const model = str(payload.model)
      const durationMs = payload.durationMs
      const duration =
        typeof durationMs === "number" && Number.isFinite(durationMs)
          ? `${Math.round(durationMs / 1000)}s`
          : undefined
      return {
        title: "Turn ended",
        detail: [model, duration].filter(Boolean).join(" · ") || undefined,
      }
    }
    case "target.session.started":
      return {
        title: "Session started",
        detail: str(payload.provider) ?? event.actor,
      }
    case "target.session.ended":
      return { title: "Session ended", detail: str(payload.provider) ?? event.actor }
    case "target.tool.used":
      return {
        title: "Tool used",
        detail: str(payload.declaredEvent) ?? str(payload.agentEventType),
      }
    case "target.model.updated":
      return { title: "Model updated", detail: str(payload.model) }
    case "target.context.compacted":
      return { title: "Context compacted" }
    case "target.subagent.started":
      return {
        title: "Subagent started",
        detail: str(payload.subagentType) ?? str(payload.taskDescription),
      }
    case "target.subagent.ended":
      return { title: "Subagent ended", detail: str(payload.subagentType) }
    case "file.observed": {
      const path = str(payload.path)
      const changeKind = str(payload.changeKind)
      return {
        title: changeKind ? `${changeKind} file` : "File change",
        detail: path ? tildify(path) : path,
      }
    }
    default:
      return { title: event.kind.replace(/^target\./, "").replaceAll(".", " ") }
  }
}

export const formatActivityTime = (occurredAt: string): string => {
  const date = new Date(occurredAt)
  if (Number.isNaN(date.getTime())) return occurredAt
  return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })
}

/**
 * Absolute date + time, for detail surfaces (and tooltips) where the bare
 * wall-clock time of formatActivityTime is ambiguous — "created/updated" needs
 * to say which day, not just which minute.
 */
export const formatActivityDateTime = (occurredAt: string): string => {
  const date = new Date(occurredAt)
  if (Number.isNaN(date.getTime())) return occurredAt
  return date.toLocaleString([], {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  })
}

/**
 * Compact, dateless-but-meaningful recency label for dense list rows: "now",
 * "5m", "3h", "2d", "4w". A bare wall-clock time (formatActivityTime) reads as
 * noise on a work row — same width, no sense of how stale the item is — so list
 * surfaces use this instead and keep absolute timestamps for detail views.
 */
export const formatRelativeTime = (occurredAt: string): string => {
  const then = new Date(occurredAt).getTime()
  if (Number.isNaN(then)) return ""
  const sec = Math.max(0, Math.round((Date.now() - then) / 1000))
  if (sec < 60) return "now"
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h`
  const day = Math.round(hr / 24)
  if (day < 7) return `${day}d`
  return `${Math.round(day / 7)}w`
}
