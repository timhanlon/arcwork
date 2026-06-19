import { Context, Effect, Layer } from "effect"
import type { Preset } from "../../shared/preset.js"

/**
 * Named presets (flavored providers). Seeded from the shape of
 * `.aux/agents.jsonc` for the spike.
 *
 * TODO: load and parse `.aux/agents.jsonc` via @effect/platform-node
 * FileSystem (it's JSONC — strip comments first) instead of seeding here.
 */
const presets: ReadonlyArray<Preset> = [
  {
    name: "implementer",
    provider: "cursor",
    model: "composer-2.5",
    tags: ["role:implementation"],
  },
  {
    name: "effect-reviewer",
    provider: "codex",
    model: "gpt-5.4-mini",
    instructionsFile: ".aux/agents/effect-reviewer.md",
    tags: ["role:review"],
  },
]

export class PresetRegistry extends Context.Service<
  PresetRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<Preset>>
    readonly get: (name: string) => Effect.Effect<Preset | undefined>
  }
>()("PresetRegistry") {}

export const PresetRegistryLive = Layer.succeed(PresetRegistry, {
  list: Effect.succeed(presets),
  get: (name) => Effect.succeed(presets.find((p) => p.name === name)),
})
