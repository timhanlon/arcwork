import { useState } from "react"
import { Chip } from "./Chip.js"

export default {
  title: "Components / Chip",
}

/** Resting vs. active (pressed) treatment — the shared accent-border toggle. */
export const States = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    <Chip>resting</Chip>
    <Chip active className="text-accent">
      active
    </Chip>
    <Chip disabled>disabled</Chip>
  </div>
)

/**
 * The work-list filter tabs in miniature: a single-select row where the active
 * tab takes the accent border + accent text, and carries a trailing count.
 */
export const FilterTabs = () => {
  const tabs = ["all", "open", "active", "done"] as const
  const counts: Record<(typeof tabs)[number], number> = { all: 12, open: 5, active: 4, done: 3 }
  const [tab, setTab] = useState<(typeof tabs)[number]>("open")
  return (
    <div style={{ display: "flex", gap: 4, flexWrap: "wrap" }}>
      {tabs.map((t) => {
        const active = t === tab
        return (
          <Chip
            key={t}
            active={active}
            className={`focus-visible:ring-accent ${
              active ? "text-accent" : "enabled:hover:border-border-strong enabled:hover:text-foreground"
            }`}
            onClick={() => setTab(t)}
          >
            {t}
            <span className={`text-[10px] ${active ? "text-accent" : "text-fg-faint"}`}>{counts[t]}</span>
          </Chip>
        )
      })}
    </div>
  )
}

/**
 * The composer's status chips: a filled active treatment (the addressee) beside
 * resting chips, plus the "needs attention" request ring. Confirms the two
 * active idioms (accent-text tab vs. filled status chip) share one skeleton.
 */
export const StatusChips = () => (
  <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center" }}>
    <Chip active className="h-7 bg-accent/10 text-foreground enabled:hover:border-accent focus-visible:ring-accent">
      claude · generating
    </Chip>
    <Chip className="h-7 bg-background enabled:hover:border-accent focus-visible:ring-accent">
      codex · idle
    </Chip>
    <Chip className="h-7 bg-background shadow-[0_0_0_1px_color-mix(in_srgb,var(--request)_28%,transparent)] enabled:hover:border-request focus-visible:ring-request">
      claude · needs input
    </Chip>
  </div>
)
