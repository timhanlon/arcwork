import type { LiveTargetActivity } from "../../../shared/live-target-state.js"

// The generic row recipe + tree-row layout primitives live on the Row primitive
// now; re-exported so the sidebar keeps its import path while the work/git list
// panes share the same definitions via <Row>.
export { ROW_BASE, ROW_ACTIVE, ROW_GRID, DISCLOSURE } from "../ui/Row.js"

/**
 * The one word that describes a session's live status. Drives both the status
 * dot's colour (via the SESSION_DOT map) and the row tooltip. It is the live
 * activity projection ({@link LiveTargetActivity}) plus "active" for the focused
 * row. "detached" means no live PTY handle in this process — the common resting
 * state, so the dot renders it faint rather than shouting it on every row.
 */
export type SessionDisplayStatus = LiveTargetActivity | "active"

export const TREE_MAIN = "grid min-w-0 gap-px"
export const TREE_LABEL = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px]"
/**
 * Chat-name label. A chat is the parent of its target rows, so it reads in the
 * UI font with a touch more weight at full foreground tone — distinct from the
 * faint, monospaced provider names ({@link TREE_LABEL}) nested beneath it.
 */
export const CHAT_LABEL =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[12px] font-medium text-foreground"
export const TREE_SUBTITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-fg-dim"

/**
 * Session status → leading-dot styling. "detached" (the resting state) is a quiet
 * hollow ring; live states fill the dot with their tone, "active" adds a halo.
 */
export const SESSION_DOT: Record<string, string> = {
  active: "bg-accent shadow-[0_0_0_2px_color-mix(in_srgb,var(--accent)_28%,transparent)]",
  generating: "bg-ok",
  waiting_for_input: "bg-request",
  waiting_for_approval: "bg-request",
  exited: "bg-fg-faint",
  idle: "bg-fg-dim",
}
export const SESSION_DOT_DETACHED = "bg-transparent shadow-[inset_0_0_0_1px_var(--fg-faint)]"

/** The compact "+ new" chat button pinned to a workspace's Chats header. Stays
 * out of the way — invisible until the header is hovered (or the button itself
 * takes keyboard focus). */
export const CHAT_NEW_BUTTON =
  "min-h-5 w-auto flex-none cursor-pointer rounded-[var(--radius)] border border-border-strong bg-transparent px-2 py-0.5 font-mono text-[10px] text-fg-dim opacity-0 hover:bg-elev hover:text-foreground focus-visible:bg-elev focus-visible:text-foreground focus-visible:opacity-100 focus-visible:outline-none group-hover/header:opacity-100"
/** The "show all / show fewer" expander under a capped chat list. */
export const CHAT_EXPANDER_BUTTON =
  "w-full cursor-pointer bg-transparent py-1 pl-row-indent pr-2 text-left font-mono text-[10px] text-fg-faint hover:text-foreground focus-visible:text-foreground focus-visible:outline-none"
