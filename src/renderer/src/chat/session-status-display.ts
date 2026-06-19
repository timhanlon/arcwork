import type { LiveTargetActivity } from "../../../shared/live-target-state.js"
import type { SessionDisplayStatus } from "../sidebar/row-styles.js"

export interface TargetStatusDisplay {
  readonly label: string
  readonly textTone: string
  readonly needsAttention: boolean
}

export const targetStatusDisplay = (status: SessionDisplayStatus): TargetStatusDisplay => {
  switch (status) {
    case "active":
      return { label: "active", textTone: "text-accent", needsAttention: false }
    case "generating":
      return { label: "generating", textTone: "text-ok", needsAttention: false }
    case "waiting_for_input":
      return { label: "needs input", textTone: "text-request", needsAttention: true }
    case "waiting_for_approval":
      return { label: "needs approval", textTone: "text-request", needsAttention: true }
    case "idle":
      return { label: "idle", textTone: "text-fg-dim", needsAttention: false }
    case "exited":
      return { label: "exited", textTone: "text-fg-faint", needsAttention: false }
    case "detached":
      return { label: "detached", textTone: "text-fg-faint", needsAttention: false }
  }
}

export const activityNeedsAttention = (activity: LiveTargetActivity): boolean =>
  targetStatusDisplay(activity).needsAttention
