import type { LiveTargetActivity } from "../../../shared/live-target-state.js"

/**
 * The one word that describes a session's live status. Drives both the status
 * dot's colour (via the SESSION_DOT map) and the row tooltip. It is the live
 * activity projection ({@link LiveTargetActivity}) plus "active" for the focused
 * row. "detached" means no live PTY handle in this process — the common resting
 * state, so the dot renders it faint rather than shouting it on every row.
 */
export type SessionDisplayStatus = LiveTargetActivity | "active"

// Shared row recipe. Workspace/chat rows justify their count to the right;
// session rows hug their leading status dot — hence the per-row justify/gap.
export const ROW_BASE =
  "flex min-h-7 w-full min-w-0 cursor-pointer items-center border-0 bg-transparent px-2 py-[5px] text-left text-foreground hover:bg-elev focus-visible:bg-elev focus-visible:outline-none"
export const ROW_ACTIVE = "bg-elev shadow-[inset_2px_0_0_var(--accent)]"
/**
 * Active treatment for a leaf target row. A session sits nested under its chat,
 * so it skips the chat/workspace accent bar (which reads as a loud left border
 * on a child row) and leans on the fill alone — its leading dot already carries
 * the active accent halo.
 */
export const SESSION_ACTIVE = "bg-elev"
export const ROW_GRID = "grid grid-cols-[18px_minmax(0,1fr)] items-center gap-0.5"
export const DISCLOSURE =
  "inline-flex h-6 w-[18px] cursor-pointer items-center justify-center border-0 bg-transparent p-0 text-fg-faint disabled:cursor-default disabled:opacity-[0.35]"
export const TREE_MAIN = "grid min-w-0 gap-px"
export const TREE_LABEL = "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[12px]"
/**
 * Chat-name label. A chat is the parent of its target rows, so it reads in the
 * UI font with a touch more weight at full foreground tone — distinct from the
 * faint, monospaced provider names ({@link TREE_LABEL}) nested beneath it.
 */
export const CHAT_LABEL =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[12.5px] font-medium text-foreground"
export const TREE_SUBTITLE =
  "min-w-0 overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-fg-faint"

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
