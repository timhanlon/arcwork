import { PR_STATE_COLOR, PrStateIcon, type PrState } from "./PrStateIcon.js"

export default {
  title: "Git / PrStateIcon",
}

const ALL: ReadonlyArray<PrState> = ["open", "merged", "closed"]

/** Each state with its GitHub colour convention (open green, merged purple,
 * closed red), shown next to a PR number the way callers render it. */
export const AllStates = () => (
  <div style={{ display: "grid", gap: 12, background: "var(--background)", padding: 16 }}>
    {ALL.map((state) => (
      <span
        key={state}
        className={`inline-flex items-center gap-[3px] font-mono text-[13px] ${PR_STATE_COLOR[state]}`}
      >
        <PrStateIcon state={state} size={14} />
        #128 {state}
      </span>
    ))}
  </div>
)
