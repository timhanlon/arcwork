import type { JSX } from "react"
import { useMemo } from "react"
import { Button } from "@base-ui/react/button"
import { X } from "@phosphor-icons/react"
import type { WorkItem, WorkState } from "./types.js"
import { formatRelative } from "./time.js"
import { ROW_ACTIVE } from "../row-styles.js"
import { PrStateIcon } from "../../git/PrStateIcon.js"

// Two-line inbox row laid out with named grid areas — dot spans both lines on the
// left, archive spans both on the right, title/meta/time fill the middle.
const ROW =
  "group grid [grid-template-columns:8px_minmax(0,1fr)_auto_auto] [grid-template-areas:'dot_title_title_archive'_'dot_meta_time_archive'] items-center gap-x-2.5 gap-y-0.5 w-full min-h-10 px-2 py-1.5 bg-transparent text-foreground text-left cursor-pointer outline-none hover:bg-elev focus-visible:bg-elev"

// Leading status dot — color (and, for attention, an outer glow) carries the
// lifecycle state at a glance. running/waiting/complete recolor the fill but keep
// the base inset ring; needs_attention swaps it for the glow; stale stays bare.
// Leading status dot. We key the fill/ring off the state in JS rather than via a
// `data-[state=…]` variant: the `needs_attention` underscore would be rewritten to
// a space inside Tailwind's `data-[]` arbitrary value and silently break. Each
// state sets exactly one box-shadow so there's no shorthand conflict.
// No bg-transparent here: it'd override the state fills below (equal specificity,
// later in the cascade). Stale simply sets no bg, which is transparent already.
const DOT_BASE = "[grid-area:dot] self-center w-2 h-2 rounded-full"
const RING = "[box-shadow:inset_0_0_0_1px_var(--fg-faint)]"
const DOT_STATE: Record<WorkState, string> = {
  needs_attention: "bg-danger [box-shadow:0_0_0_2px_color-mix(in_srgb,var(--danger)_26%,transparent)]",
  running: `bg-ok ${RING}`,
  waiting: `bg-request ${RING}`,
  complete: `bg-accent ${RING}`,
  stale: RING,
}

const META =
  "[grid-area:meta] flex items-center gap-2 min-w-0 overflow-hidden whitespace-nowrap text-ellipsis font-mono text-[10px] text-fg-faint [&>*]:flex-none"

// PR pill — octicon + number; the glyph's shape + color carry the state.
// GitHub conventions: open=green, merged=purple, closed=red.
const PR =
  "inline-flex items-center gap-[3px] text-fg-dim data-[state=open]:text-ok data-[state=merged]:text-[#a371f7] data-[state=closed]:text-danger"

const ARCHIVE =
  "[grid-area:archive] self-center inline-flex items-center justify-center w-5 h-5 text-fg-faint opacity-0 cursor-pointer group-hover:opacity-100 focus-visible:opacity-100 hover:text-foreground"

export interface WorkQueueProps {
  readonly items: ReadonlyArray<WorkItem>
  /** Reference time for relative labels. Defaults to the fixture anchor. */
  readonly nowMs?: number
  /** Selected row, highlighted. */
  readonly activeItemId?: string
  readonly onSelect?: (id: string) => void
  /** One-click archive/resolve affordance per row. No-op if omitted. */
  readonly onArchive?: (id: string) => void
}

/**
 * Display sections. The proposal's primary sort collapses to three visible
 * groups — Attention, Active, Recent — with the richer lifecycle states mapped
 * in. Section order *is* the priority order; within a section we sort by most
 * recent meaningful activity.
 */
const SECTIONS: ReadonlyArray<{ key: string; label: string; states: ReadonlyArray<WorkState> }> = [
  { key: "attention", label: "Attention", states: ["needs_attention"] },
  { key: "active", label: "Active", states: ["running", "waiting"] },
  { key: "recent", label: "Recent", states: ["complete", "stale"] },
]

function bucket(
  items: ReadonlyArray<WorkItem>,
  states: ReadonlyArray<WorkState>,
): ReadonlyArray<WorkItem> {
  return items
    .filter((it) => states.includes(it.state))
    .sort((a, b) => b.lastActivityAt.localeCompare(a.lastActivityAt))
}

export function WorkQueue(props: WorkQueueProps): JSX.Element {
  const nowMs = props.nowMs ?? Date.parse("2026-06-06T15:00:00Z")

  const sections = useMemo(
    () => SECTIONS.map((s) => ({ ...s, rows: bucket(props.items, s.states) })),
    [props.items],
  )

  return (
    <div className="flex flex-col gap-3.5 min-w-0 overflow-y-auto" role="list" aria-label="Work queue">
      {sections.map((section) =>
        section.rows.length === 0 ? null : (
          <section key={section.key} className="flex flex-col">
            <header className="flex items-center gap-1.5 mb-1 px-2 text-fg-faint font-mono text-[10px] uppercase tracking-[0.08em]">
              {section.label}
              <span className="text-fg-dim">{section.rows.length}</span>
            </header>
            {section.rows.map((item) => (
              <Button
                key={item.id}
                role="listitem"
                className={`${ROW}${props.activeItemId === item.id ? ` ${ROW_ACTIVE}` : ""}`}
                onClick={() => props.onSelect?.(item.id)}
                title={`${item.agent} · ${item.state} · ${item.detail}`}
              >
                <span className={`${DOT_BASE} ${DOT_STATE[item.state]}`} data-state={item.state} aria-hidden />

                <span className="[grid-area:title] min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[13px]">
                  {item.title}
                </span>
                <span className="[grid-area:time] self-center justify-self-end font-mono text-[10px] text-fg-faint whitespace-nowrap">
                  {formatRelative(item.lastActivityAt, nowMs)}
                </span>

                <span className={META}>
                  <span className="min-w-0 overflow-hidden text-ellipsis text-fg-dim">{item.project}</span>
                  {item.pr && (
                    <span className={PR} data-state={item.pr.state} title={`PR #${item.pr.number} ${item.pr.state}`}>
                      <PrStateIcon state={item.pr.state} />#{item.pr.number}
                    </span>
                  )}
                </span>

                {props.onArchive && (
                  <span
                    className={ARCHIVE}
                    role="button"
                    tabIndex={-1}
                    aria-label="Archive"
                    title="Archive"
                    onClick={(e) => {
                      e.stopPropagation()
                      props.onArchive?.(item.id)
                    }}
                  >
                    <X size={11} weight="bold" />
                  </span>
                )}
              </Button>
            ))}
          </section>
        ),
      )}
    </div>
  )
}
