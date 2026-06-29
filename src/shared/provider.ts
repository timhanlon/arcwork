import { Schema } from "effect"

/**
 * The set of agent harnesses (targets) arc ingests and projects, as a closed
 * literal union. Canonical home so the renderer-facing shared schemas and the
 * main-process ingest layer key off one definition — `ingest/db/schema.ts`
 * re-exports these. (Distinct from {@link ProviderSpec} below, which is a
 * provider's capability sheet; this is just its identity.)
 */
export const Provider = Schema.Literals(["claude", "codex", "cursor", "pi"])
export type Provider = typeof Provider.Type
export const ALL_PROVIDERS: ReadonlyArray<Provider> = ["claude", "codex", "cursor", "pi"]

/**
 * Layer 1 — Provider (the "kind"): static capability sheet for a CLI agent.
 *
 * A provider can declare TWO modes; not every provider supports both:
 *   - `batch`: how aux runs it non-interactively (Run instances)
 *   - `interactive`: how to launch a PTY session (TargetSession instances),
 *      ported from orca's TUI_AGENT_CONFIG injection knobs.
 */

export const PromptInjectionMode = Schema.Literals([
  "argv",
  "flag-prompt",
  "stdin-after-start",
  "flag-interactive",
  "flag-prompt-interactive",
  // A long-lived JSONL command stream on stdin (pi `--mode rpc`): prompts are
  // `{"type":"prompt","message":…}` lines, not terminal paste+Enter. The process
  // stays resident between turns, so follow-up/inbox messages are just more lines.
  "rpc-jsonl",
])
export type PromptInjectionMode = typeof PromptInjectionMode.Type

/** Whether a provider can run more than one instance at once. */
export const Concurrency = Schema.Literals(["per-worktree", "singleton", "unlimited"])
export type Concurrency = typeof Concurrency.Type

/** Non-interactive run capability (aux adapter). */
export const BatchCapability = Schema.Struct({
  commandName: Schema.String,
  promptFlag: Schema.optional(Schema.String),
  modelFlag: Schema.optional(Schema.String),
})
export type BatchCapability = typeof BatchCapability.Type

/** Interactive PTY launch capability (orca TUI_AGENT_CONFIG, ported). */
export const InteractiveCapability = Schema.Struct({
  launchCmd: Schema.String,
  expectedProcess: Schema.String,
  promptInjectionMode: PromptInjectionMode,
  /** native prefill flag, e.g. claude `--prefill` (eliminates the paste race) */
  draftPromptFlag: Schema.optional(Schema.String),
  /** env prefill when no flag exists (set via the launched session's env) */
  draftPromptEnvVar: Schema.optional(Schema.String),
  /**
   * The glyph this CLI prints at its input prompt once the interactive session
   * (and its MCP servers) is fully up — `❯` claude, `→` cursor, `›` codex.
   * Arc watches the tail of PTY output for it and only then submits/pastes the
   * seeded prompt, so a spawned agent's first turn sees its MCP tools rather
   * than racing connection. Absent → fall back to first-output as the signal.
   */
  readyPromptGlyph: Schema.optional(Schema.String),
  /**
   * Pre-session gates this CLI parks at before its input prompt is ever reached
   * — e.g. cursor-agent shows a "Workspace Trust Required" dialog (and, logged
   * out, a "Press any key to log in" screen) in a fresh PTY. When a gate's
   * `match` substring appears in early output, Arc sends its `key` once to
   * advance past it, so the `readyPromptGlyph` can then appear and the seeded
   * prompt deliver. Without this the glyph never shows and the prompt strands.
   * Each gate fires at most once, in output order.
   */
  advanceGates: Schema.optional(
    Schema.Array(Schema.Struct({ match: Schema.String, key: Schema.String })),
  ),
})
export type InteractiveCapability = typeof InteractiveCapability.Type

export const ProviderSpec = Schema.Struct({
  kind: Provider,
  displayName: Schema.String,
  detectCmd: Schema.String,
  concurrency: Concurrency,
  batch: Schema.optional(BatchCapability),
  interactive: Schema.optional(InteractiveCapability),
})
export type ProviderSpec = typeof ProviderSpec.Type
