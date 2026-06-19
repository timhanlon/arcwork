import { useState } from "react"
import { Select } from "./Select.js"

export default {
  title: "Components / Select",
}

const STATUS = [
  { value: "open" },
  { value: "active" },
  { value: "blocked" },
  { value: "done" },
  { value: "superseded" },
] as const

const PRIORITY = [{ value: "p0" }, { value: "p1" }, { value: "p2" }, { value: "p3" }] as const

/** The themed picker on its own — open it to confirm the popup matches the dark
 * theme (no OS-native chrome) and the active row carries a checkmark. */
function Basic() {
  const [status, setStatus] = useState<string>("active")
  const [priority, setPriority] = useState<string | null>(null)
  return (
    <div style={{ display: "flex", gap: 16, width: 360, padding: 24 }}>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ font: "10px ui-monospace, monospace", color: "var(--fg-faint)" }}>status</span>
        <Select value={status} options={STATUS} onValueChange={setStatus} aria-label="status" />
      </label>
      <label style={{ display: "flex", flexDirection: "column", gap: 4 }}>
        <span style={{ font: "10px ui-monospace, monospace", color: "var(--fg-faint)" }}>priority</span>
        <Select
          value={priority}
          options={PRIORITY}
          onValueChange={setPriority}
          placeholder="— none"
          aria-label="priority"
        />
      </label>
    </div>
  )
}

/** Reproduces the work-detail header: the picker sits inside a `sticky z-10`
 * bar. Opening it must paint the popup *above* the bar — the z-index regression
 * the native `<select>` never had (its popup was OS-drawn). */
function UnderStickyHeader() {
  const [status, setStatus] = useState<string>("open")
  return (
    <div style={{ width: 420, height: 300, overflow: "auto", border: "1px solid var(--border)" }}>
      <div
        className="sticky top-0 z-10"
        style={{ background: "var(--background)", borderBottom: "1px solid var(--border)", padding: 12 }}
      >
        <Select value={status} options={STATUS} onValueChange={setStatus} aria-label="status" />
      </div>
      <div style={{ padding: 12, color: "var(--fg-dim)" }}>
        {Array.from({ length: 12 }, (_, i) => (
          <p key={i}>scrolling body content {i}</p>
        ))}
      </div>
    </div>
  )
}

export const Basic_ = () => <Basic />
export const StickyHeader = () => <UnderStickyHeader />
