/** Shared layout and field styling for the work navigator views. */
export const HEADER =
  "flex flex-none items-center justify-between gap-2 border-b border-border px-4 pb-3 pt-[14px]"
export const PANE_TITLE = "m-0 font-sans text-[15px] font-medium"
export const HEADER_ACTIONS = "flex items-center gap-1"
export const ERROR_BANNER =
  "mx-4 mt-2.5 flex-none rounded-[var(--radius)] border border-danger px-2 py-1.5 text-[12px] text-danger"
export const FIELD_LABEL = "font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint"
export const LABEL_CHIP =
  "rounded-[var(--radius)] border border-border px-1 font-mono text-[10px] text-fg-dim"
export const FIELD = "flex flex-col gap-1"
export const FIELD_BASE =
  "w-full rounded-[var(--radius)] border border-border bg-input px-2 py-1.5 text-[13px] text-foreground focus:border-accent focus:outline-none"
export const FIELD_INPUT = `${FIELD_BASE} font-sans`
export const FIELD_TEXTAREA = `${FIELD_BASE} resize-y font-mono leading-[1.5]`
export const FORM_ACTIONS = "flex justify-end gap-2"
/** The work-detail editor's scrolling field region — the title/body/labels live
 * here and scroll, leaving {@link DETAIL_ACTIONS_BAR} pinned below. */
export const DETAIL_EDIT_FIELDS = "flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4"
/** Editor action bar, a flex-none sibling *below* the scroll region (not inside
 * it), so it stays pinned to the pane bottom regardless of body length — the
 * footer twin of {@link DETAIL_TOP}. */
export const DETAIL_ACTIONS_BAR =
  "flex flex-none items-center justify-end gap-2 border-t border-border bg-background px-4 py-2.5"
export const WORK_DOT = "size-2 flex-none rounded-full"
export const DETAIL_TOP = "sticky top-0 z-10 flex-none border-b border-border bg-background"
export const DETAIL_HEADER = `${HEADER} border-b-0`
export const DETAIL_BODY = "flex min-h-0 flex-1 flex-col gap-[14px] overflow-y-auto p-4"
