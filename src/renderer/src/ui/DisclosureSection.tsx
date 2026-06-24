import type { JSX, ReactNode } from "react"
import { Caret } from "./Caret.js"

export interface DisclosureSectionProps {
  readonly title: string
  /** Trailing count beside the title; omit to hide (e.g. while loading). */
  readonly count?: number
  readonly open: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
  /**
   * Grow to fill the available height and scroll internally when open — the
   * pane layout (git Changes/Commits). Default false: natural height for stacked
   * or nested use (the sidebar's Active/Chats sections), where an outer
   * container does the scrolling.
   */
  readonly fill?: boolean
  /** Accessory between the caret and the title — e.g. a live-status dot. */
  readonly leading?: ReactNode
  /** Controls pinned to the header's trailing edge — e.g. a "+ new" button.
   * Rendered as a sibling of the toggle (never nested inside the button). */
  readonly actions?: ReactNode
  /** Pin the header to the top of the scroll container while the section's body
   * scrolls beneath it (iOS-style section headers). The header stays stuck only
   * while this section is in view, so stacked sticky sections hand off cleanly. */
  readonly sticky?: boolean
}

/**
 * One collapsible section: a header that toggles a body. Uppercase mono label,
 * caret, dim count, hairline divider — used identically by the sidebar tree and
 * the git pane so every accordion reads the same. The caret rides the same
 * gutter column as the rows beneath it ({@link ROW_GRID}'s disclosure slot), so
 * section and row carets stack in one column. `fill` switches between the pane
 * layout (grow + internal scroll) and the stacked layout (natural height).
 */
export function DisclosureSection({
  title,
  count,
  open,
  onToggle,
  children,
  fill = false,
  leading,
  actions,
  sticky = false,
}: DisclosureSectionProps): JSX.Element {
  return (
    <div
      className={`flex min-h-0 flex-col border-b border-border ${fill ? (open ? "flex-1" : "flex-none") : ""}`}
    >
      <div
        className={`group/header flex gap-2 items-center ${sticky ? "sticky top-0 z-10 border-b border-border bg-background" : ""}`}
      >
        <button
          type="button"
          onClick={onToggle}
          aria-expanded={open}
          className="flex min-w-0 flex-1 items-center gap-0.5 py-1.5 px-2 text-left font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint hover:bg-elev hover:text-foreground focus-visible:bg-elev focus-visible:text-foreground focus-visible:outline-none"
        >
          {/* Same <Caret> the rows use, so section and row carets line up in one
              column (ROW_GRID's first track) for free. */}
          <Caret open={open} />
          <span className="flex min-w-0 items-center gap-1.5">
            {leading}
            <span className="truncate">{title}</span>
            {count !== undefined && <span className="text-fg-dim">{count}</span>}
          </span>
        </button>
        {actions ? <div className="flex flex-none items-center gap-1 pr-2">{actions}</div> : null}
      </div>
      {open ? (
        <div className={fill ? "min-h-0 flex-1 overflow-y-auto" : undefined}>{children}</div>
      ) : null}
    </div>
  )
}
