import { SessionDot } from "./SessionDot.js"
import type { SessionDisplayStatus } from "./row-styles.js"

export default {
  title: "Sidebar / SessionDot",
}

const ALL: ReadonlyArray<SessionDisplayStatus> = [
  "active",
  "generating",
  "waiting_for_input",
  "waiting_for_approval",
  "idle",
  "exited",
  "detached",
]

/** The whole status vocabulary in one row, each dot labelled. */
export const AllStates = () => (
  <div style={{ display: "grid", gap: 10 }}>
    {ALL.map((status) => (
      <div key={status} style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <SessionDot status={status} />
        <span style={{ fontFamily: "var(--font-mono)", fontSize: 12, color: "var(--fg-dim)" }}>
          {status}
        </span>
      </div>
    ))}
  </div>
)
