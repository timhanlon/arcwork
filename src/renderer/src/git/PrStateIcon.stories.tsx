import { PrStateIcon, prStateColor, type PrState } from "./PrStateIcon.js"

export default {
  title: "Git / PrStateIcon",
}

const ALL: ReadonlyArray<{ state: PrState; isDraft?: boolean; label: string }> = [
  { state: "open", label: "open" },
  { state: "open", isDraft: true, label: "draft" },
  { state: "merged", label: "merged" },
  { state: "closed", label: "closed" },
]

/** Each state with its GitHub colour convention (open green, merged purple,
 * closed red, draft muted), shown next to a PR number the way callers render it. */
export const AllStates = () => (
  <div style={{ display: "grid", gap: 12, background: "var(--background)", padding: 16 }}>
    {ALL.map(({ state, isDraft, label }) => (
      <span
        key={label}
        className={`inline-flex items-center gap-[3px] font-mono text-[13px] ${prStateColor(state, isDraft)}`}
      >
        <PrStateIcon state={state} isDraft={isDraft} size={14} />
        #128 {label}
      </span>
    ))}
  </div>
)
