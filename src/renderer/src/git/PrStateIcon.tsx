import type { JSX } from "react"
import {
  GitMergeIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  GitPullRequestIcon,
  type Icon,
} from "@primer/octicons-react"
import type { PrState } from "../../../shared/git.js"

export type { PrState }

const STATE_ICON: Record<PrState, Icon> = {
  open: GitPullRequestIcon,
  merged: GitMergeIcon,
  closed: GitPullRequestClosedIcon,
}

/** GitHub's state colour conventions: open green, merged purple, closed red; a
 * draft PR is muted regardless of being technically open. */
export const PR_STATE_COLOR: Record<PrState, string> = {
  open: "text-ok",
  merged: "text-[#a371f7]",
  closed: "text-danger",
}
const PR_DRAFT_COLOR = "text-fg-dim"

/** The tone for a PR's state + draft, for colouring the icon and number together. */
export const prStateColor = (state: PrState, isDraft = false): string =>
  isDraft && state === "open" ? PR_DRAFT_COLOR : PR_STATE_COLOR[state]

/** The PR-state octicon, inheriting colour via `currentColor` — the caller sets
 * the tone (see {@link prStateColor}). A draft open PR gets the distinct draft
 * glyph, so "draft" never needs a separate text label. */
export function PrStateIcon({
  state,
  isDraft = false,
  size = 12,
}: {
  readonly state: PrState
  readonly isDraft?: boolean
  readonly size?: number
}): JSX.Element {
  const IconComponent = isDraft && state === "open" ? GitPullRequestDraftIcon : STATE_ICON[state]
  return <IconComponent size={size} className="flex-none" />
}
