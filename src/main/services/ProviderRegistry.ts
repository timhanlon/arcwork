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
      readyPromptGlyph: "❯",
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
      promptInjectionMode: "stdin-after-start",
      readyPromptGlyph: "›",
    },
    // Drive codex directly over the app-server JSON-RPC protocol (see
    // ingest/providers/codex-appserver/driver.ts) — additive to the scraper +
    // TUI paths above.
    appServer: { launchCmd: "codex", args: ["app-server"] },
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
      // Paste-after-ready (gated on the `→` glyph below), not a positional argv
      // prompt: an argv prompt starts turn 1 during early startup, before the
      // plugin's HTTP MCP servers connect, so the agent's first turn sees no arc
      // tools. Waiting for the prompt glyph lets MCP come up first.
      promptInjectionMode: "stdin-after-start",
      readyPromptGlyph: "→",
      // Fresh PTY launches park at a gate before the agent TUI (and its `→`
      // prompt) appear: a workspace-trust dialog (select `[a] Trust`) and, when
      // logged out, a "press any key to log in" screen (Enter). Clear each so
      // the ready glyph can show.
      advanceGates: [
        { match: "Workspace Trust Required", key: "a" },
        { match: "Press any key to log in", key: "\r" },
      ],
    },
  },
  {
    kind: "pi",
    displayName: "pi (local)",
    detectCmd: "pi",
    // Local-model agent (via LM Studio). No machine-wide singleton constraint and
    // no cloud/approval gate, so it's the workhorse for orchestration testing.
    concurrency: "per-worktree",
    batch: { commandName: "pi", promptFlag: "-p", modelFlag: "--model" },
    interactive: {
      launchCmd: "pi",
      expectedProcess: "pi",
      // A normal interactive TUI, human-drivable like the other providers; the
      // arc toolkit + lifecycle hook relay come from the `-e` extension, and the
      // inbox pastes follow-ups. (pi can also run as a JSONL rpc server — see
      // piLaunchArgs `rpc` + the `rpc-jsonl` injection mode — but the TUI is the
      // default so pi is launchable by hand.)
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
