import { ProviderIcon, PROVIDERS_WITH_ICON } from "./ProviderIcon.js"

export default {
  title: "Components / ProviderIcon",
}

/** Every provider mark we ship, at the size session rows use (16px). */
export const Gallery = () => (
  <div style={{ display: "flex", gap: 20, flexWrap: "wrap", color: "var(--foreground)" }}>
    {PROVIDERS_WITH_ICON.map((p) => (
      <div
        key={p}
        style={{ display: "grid", justifyItems: "center", gap: 6, fontFamily: "var(--mono)", fontSize: 11 }}
      >
        <ProviderIcon provider={p} size={24} />
        <span style={{ color: "var(--fg-dim)" }}>{p}</span>
      </div>
    ))}
  </div>
)

/** A single mark scaled up to inspect path fidelity at the curated grid. */
export const Sizes = () => (
  <div style={{ display: "flex", gap: 16, alignItems: "flex-end", color: "var(--foreground)" }}>
    {[12, 16, 20, 32, 48].map((s) => (
      <ProviderIcon key={s} provider="codex" size={s} />
    ))}
  </div>
)

/**
 * Inline beside the provider label, mirroring the session-row layout: the mark
 * inherits `currentColor`, so it tracks the label's tone in rest/dim states.
 */
export const InlineWithLabel = () => (
  <div style={{ display: "grid", gap: 8, width: 220 }}>
    {PROVIDERS_WITH_ICON.map((p) => (
      <div
        key={p}
        style={{
          display: "flex",
          alignItems: "center",
          gap: 7,
          fontFamily: "var(--mono)",
          fontSize: 12,
          color: "var(--fg-dim)",
        }}
      >
        <ProviderIcon provider={p} size={14} />
        <span>{p}</span>
      </div>
    ))}
  </div>
)
