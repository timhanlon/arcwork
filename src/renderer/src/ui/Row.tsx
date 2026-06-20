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
  "flex min-h-7 w-full min-w-0 cursor-pointer items-center border-0 bg-transparent px-2 py-[5px] text-left text-foreground hover:bg-elev focus-visible:bg-elev focus-visible:outline-none"

/** Selected row: fill plus a left accent bar. The one selection treatment for lists. */
export const ROW_ACTIVE = "bg-elev shadow-[inset_2px_0_0_var(--accent)]"

export interface RowProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  /** Renders the selected treatment (fill + left accent bar). */
  readonly active?: boolean
  readonly className?: string
  readonly children: ReactNode
}

/**
 * A full-width, left-aligned, single-select list row — the companion to
 * {@link Button} for selectable lists (work list, git changes, …). Pass `active`
 * for the selected row; extend layout (grid, gaps, deeper padding) via className.
 */
export function Row({ active = false, className, children, ...rest }: RowProps): JSX.Element {
  const cls = [ROW_BASE, active ? ROW_ACTIVE : "", className].filter(Boolean).join(" ")
  return (
    <BaseButton className={cls} {...rest}>
      {children}
    </BaseButton>
  )
}
