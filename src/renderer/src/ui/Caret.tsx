import type { JSX } from "react"
import { CaretDown, CaretRight } from "@phosphor-icons/react"

/**
 * The disclosure triangle, in a fixed box (`--spacing-caret`). Every caret — a
 * {@link DisclosureSection} header, a tree row's toggle — renders this one
 * component, so they all occupy the same width and line up automatically: caret
 * alignment is a consequence of using the same part, not of matching paddings.
 *
 * Presentational. The enclosing control (a header button, a Collapsible.Trigger)
 * owns the click; this just tracks `open`.
 */
export function Caret({ open }: { readonly open: boolean }): JSX.Element {
  return (
    <span className="inline-flex w-caret flex-none items-center justify-center text-fg-faint">
      {open ? <CaretDown size={12} weight="bold" /> : <CaretRight size={12} weight="bold" />}
    </span>
  )
}
