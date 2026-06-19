import { Schema } from "effect"

/**
 * Layer 2 — Preset (a named flavor over a provider). Mode-agnostic config.
 *
 * Source: `.aux/agents.jsonc`. A preset references a provider and supplies
 * model + instructions + tags. For the spike, presets resolve batch-only;
 * the interactive-flavored path (`@reviewer` as a seeded session) is a later
 * switch-flip — the type already leaves room for it.
 */
export const Preset = Schema.Struct({
  name: Schema.String, // "implementer" | "effect-reviewer" | "scout"
  provider: Schema.String, // references ProviderSpec.kind
  model: Schema.optional(Schema.String),
  instructionsFile: Schema.optional(Schema.String),
  tags: Schema.optional(Schema.Array(Schema.String)),
})
export type Preset = typeof Preset.Type
