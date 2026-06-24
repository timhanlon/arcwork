import { Button as BaseButton } from "@base-ui/react/button"
import type { ComponentProps, JSX, ReactNode } from "react"

/**
 * The generic selectable-list-row recipe. Rows are not {@link Button}s: a button
 * signals its affordance with a border/text accent, a row fills (`bg-elev`) across
 * its full width and left-aligns. Keeping them as separate primitives is what
 * stops list surfaces from inheriting a button's `font-mono` + hover-accent and
 * reading differently from one pane to the next.
 */
export const ROW_BASE =
  "flex min-h-7 w-full min-w-0 cursor-pointer items-center border-0 bg-transparent px-2 py-1.5 text-left text-foreground hover:bg-elev focus-visible:bg-elev focus-visible:outline-none"

/**
 * A tree row's layout: `[caret | content]` at a flush `pl-2` (matching a
 * {@link DisclosureSection} header's `px-2`), so a row's caret lands under its
 * section header's caret. The first track is one caret wide ({@link Caret}); the
 * {@link Row} body fills the rest. Rows with no caret leave the first track
 * empty. Nesting is opt-in via {@link Indent} — never a bespoke `ml-*`.
 *
 * Two independent knobs (see tailwind.css `@theme`): `--spacing-caret` is the
 * caret's fixed box and this grid's first column; `--spacing-gutter` is the
 * Indent step. They default equal so the ladder reads cleanly, but tightening
 * the nesting never resizes the caret.
 */
export const ROW_GRID = "grid grid-cols-[var(--spacing-caret)_minmax(0,1fr)] items-center gap-0.5 pl-2"
/** The clickable wrapper for a caret toggle (the row's disclosure control or a
 * git file's diff toggle). Width comes from the {@link Caret} it wraps. */
export const DISCLOSURE =
  "inline-flex h-6 cursor-pointer items-center justify-center border-0 bg-transparent p-0 disabled:cursor-default disabled:opacity-[0.35]"

/**
 * Selected-row treatments, one per nesting depth — the sidebar's variant table,
 * picked by {@link RowProps.activeStyle} so callers stop hand-concatenating
 * `${ROW_BASE} ${selected ? ROW_ACTIVE : ""}` at each site.
 *
 * - `bar` — fill plus a left accent bar. The default, for rows that head a
 *   subtree (workspace, chat) where the bar reads as "this branch is current".
 * - `fill` — fill only. For a leaf nested under its parent (a session), where a
 *   second accent bar beside the parent's would read as a loud double border;
 *   the row's own status dot already carries the active accent.
 */
const ROW_ACTIVE_BY_STYLE = {
  bar: "bg-elev shadow-[inset_2px_0_0_var(--accent)]",
  fill: "bg-elev",
} as const

export type RowActiveStyle = keyof typeof ROW_ACTIVE_BY_STYLE

/** Selected row: fill plus a left accent bar. The default selection treatment. */
export const ROW_ACTIVE = ROW_ACTIVE_BY_STYLE.bar

export interface RowProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  /** Renders the selected treatment for the chosen {@link activeStyle}. */
  readonly active?: boolean
  /** Which selected treatment to apply when `active`. Defaults to `bar`. */
  readonly activeStyle?: RowActiveStyle
  readonly className?: string
  readonly children: ReactNode
}

/**
 * A full-width, left-aligned, single-select list row — the companion to
 * {@link Button} for selectable lists (work list, git changes, sidebar tree …).
 * Pass `active` for the selected row and `activeStyle` to pick its depth-
 * appropriate treatment; extend layout (grid, gaps, deeper padding) via className.
 */
export function Row({ active = false, activeStyle = "bar", className, children, ...rest }: RowProps): JSX.Element {
  const cls = [ROW_BASE, active ? ROW_ACTIVE_BY_STYLE[activeStyle] : "", className].filter(Boolean).join(" ")
  return (
    <BaseButton className={cls} {...rest}>
      {children}
    </BaseButton>
  )
}
