import { useState } from "react"
import { type TranscriptFilter, TranscriptFilterMenu } from "./TranscriptFilterMenu.js"

export default {
  title: "Chat / TranscriptFilterMenu",
}

/**
 * The header control on its own. Open it to confirm the radio menu's checkmark
 * tracks the active level; the trigger funnel fills once you pick anything other
 * than "everything". Lives flush-right in the chat header, so it's shown against
 * a faux header bar here.
 */
export const Menu = () => {
  const [filter, setFilter] = useState<TranscriptFilter>("all")
  return (
    <div
      style={{
        width: 360,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--background)",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "flex-end",
          borderBottom: "1px solid var(--border)",
          padding: "10px 14px",
        }}
      >
        <TranscriptFilterMenu value={filter} onChange={setFilter} />
      </header>
      <div style={{ padding: 14, color: "var(--fg-dim)", fontFamily: "var(--mono)", fontSize: 12 }}>
        showing: {filter}
      </div>
    </div>
  )
}
