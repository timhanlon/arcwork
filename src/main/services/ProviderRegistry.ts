import { Context, Effect, Layer } from "effect"
import type { ProviderSpec } from "../../shared/provider.js"

/**
 * The merged catalog of provider kinds — one source of truth for both the aux
 * adapter (batch) and the orca-style PTY launch config (interactive).
 * Seeded here for the spike; later this is Schema-loaded / extensible.
 */
const providers: ReadonlyArray<ProviderSpec> = [
  {
    kind: "claude",
    displayName: "Claude Code",
    detectCmd: "claude",
    concurrency: "per-worktree",
    batch: { commandName: "claude", promptFlag: "-p", modelFlag: "--model" },
    interactive: {
      launchCmd: "claude",
      expectedProcess: "claude",
      promptInjectionMode: "argv",
      // `claude --prefill <text>` seeds the input box without submitting —
      // eliminates the paste-after-ready race (see orca audit).
      draftPromptFlag: "--prefill",
    },
  },
  {
    kind: "codex",
    displayName: "Codex",
    detectCmd: "codex",
    concurrency: "per-worktree",
    batch: { commandName: "codex", promptFlag: "exec", modelFlag: "--model" },
    interactive: {
      launchCmd: "codex",
      expectedProcess: "codex",
      promptInjectionMode: "argv",
    },
  },
  {
    kind: "cursor",
    displayName: "Cursor Agent",
    detectCmd: "cursor-agent",
    // Cursor agent is effectively one-at-a-time per machine; worktrees give
    // isolation but the broker should still treat it carefully.
    concurrency: "singleton",
    batch: { commandName: "cursor-agent", promptFlag: "-p", modelFlag: "--model" },
    interactive: {
      launchCmd: "cursor-agent",
      expectedProcess: "cursor-agent",
      // stdin-after-start uses delayed submit in TargetSessionManager (text, then \r).
      promptInjectionMode: "stdin-after-start",
    },
  },
]

export class ProviderRegistry extends Context.Service<
  ProviderRegistry,
  {
    readonly list: Effect.Effect<ReadonlyArray<ProviderSpec>>
    readonly get: (kind: string) => Effect.Effect<ProviderSpec | undefined>
  }
>()("ProviderRegistry") {}

export const ProviderRegistryLive = Layer.succeed(ProviderRegistry, {
  list: Effect.succeed(providers),
  get: (kind) => Effect.succeed(providers.find((p) => p.kind === kind)),
})
