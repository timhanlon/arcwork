export interface ParsedRecap {
  /** "where you left off" context, with a leading `Goal:` label stripped */
  readonly goal: string | null
  /** the suggested next step, taken from a `Next:` clause */
  readonly next: string | null
  /** the recap text with Claude's `(disable recaps in /config)` hint removed */
  readonly body: string
}

// Claude Code appends this hint to every away_summary; it is UI chrome, not part
// of the recap, so strip it before display.
const RECAP_HINT = /\s*\(disable recaps[^)]*\)\s*$/i
const GOAL_LABEL = /^goal:\s*/i
const NEXT_MARKER = /\bnext:\s*/i

/**
 * Best-effort split of a Claude `away_summary` recap into its "where you left
 * off" goal and the "Next:" step. The on-disk format is loose — most recaps open
 * with "Goal:" and end with a "Next:" clause, but some open with "You committed…"
 * or "Implemented…" and omit one or both markers — so anything unrecognized
 * leaves `goal`/`next` null and the card falls back to showing `body` whole.
 */
export const parseRecap = (content: string): ParsedRecap => {
  const body = content.replace(RECAP_HINT, "").trim()
  const marker = body.match(NEXT_MARKER)
  if (!marker || marker.index === undefined) {
    // No `Next:` clause: only treat the text as a structured goal when it opens
    // with an explicit `Goal:` label. Without either marker the recap is opaque,
    // so leave goal/next null and let the card render the raw body whole.
    const goal = GOAL_LABEL.test(body) ? body.replace(GOAL_LABEL, "").trim() || null : null
    return { goal, next: null, body }
  }
  const goal = body.slice(0, marker.index).replace(GOAL_LABEL, "").trim()
  const next = body.slice(marker.index + marker[0].length).trim()
  return { goal: goal || null, next: next || null, body }
}
