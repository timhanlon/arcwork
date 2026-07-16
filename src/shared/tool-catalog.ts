import type { Provider } from "./provider.js"

/**
 * Single source of truth for "the targets + tools we know about, whether we have
 * dedicated rendering for them, and (via the samples module) whether they have a
 * story". Three lists used to drift independently — the ingest classifier
 * (`ingest/extract/tool-kind.ts`), the renderer dispatch (`tool-body.tsx`), and
 * the Storybook fixtures. They now all derive from {@link TOOL_CATALOG} here.
 *
 * Two axes, kept honest by construction:
 *   - `kind`   — coarse classification, sourced from {@link KIND_BY_NAME} (so a
 *                catalog row can never disagree with `classifyTool`).
 *   - `render` — which renderer the row's args flow through; `"fallback"` means
 *                "no dedicated rendering yet" (raw JSON), so the matrix column is
 *                a field, not a guess.
 *
 * This module is metadata only — Storybook/test sample args live in
 * `tool-catalog.samples.ts` so fixtures never leak into the main/renderer
 * bundles. Keep the JS catalog in sync with the native Swift classifier
 * (`ToolType` / `PathHints.classifyToolType`); see tool-kind.ts.
 */

/**
 * Coarse tool classification shared across providers. Started from SpecStory's
 * (write | read | search | shell | task | generic | unknown) and extended for
 * agent-harness concepts that set never anticipated: agent (subagent
 * delegation), mcp (open MCP namespace), diagnostic (language-server output),
 * hitl (human-in-the-loop prompts). Best-effort metadata for querying, not a
 * contract.
 */
export type ToolKind =
  | "write"
  | "read"
  | "search"
  | "shell"
  | "task"
  | "agent"
  | "mcp"
  | "diagnostic"
  | "hitl"
  | "generic"
  | "unknown"

/**
 * Which renderer a tool's args flow through in `tool-body.tsx`:
 *   - `shell`    — a command string (Bash / exec_command / Shell)
 *   - `diff`     — a before/after unified diff (Edit / apply_patch / StrReplace)
 *   - `write`    — a target path plus a written file body (Write)
 *   - `path`     — file/pattern fields (Read / Glob / Grep / view_image / Delete)
 *   - `fallback` — no dedicated rendering yet; caller formats args as JSON
 */
export type RenderShape = "shell" | "diff" | "write" | "path" | "fallback"

export interface ToolEntry {
  readonly provider: Provider
  /** exact native tool name as the provider emits it (case-sensitive) */
  readonly name: string
  readonly kind: ToolKind
  readonly render: RenderShape
}

/**
 * Name → coarse kind, provider-agnostic. The authority for `kind`: catalog rows
 * derive their kind from here, and {@link classifyTool} falls back to it for
 * names without a catalog row. Keys are lowercased tool names.
 */
const KIND_BY_NAME: Record<string, ToolKind> = {
  // Claude Code
  write: "write",
  edit: "write",
  multiedit: "write",
  notebookedit: "write",
  read: "read",
  notebookread: "read",
  grep: "search",
  glob: "search",
  websearch: "search",
  webfetch: "search",
  toolsearch: "search",
  bash: "shell",
  bashoutput: "shell",
  killbash: "shell",
  killshell: "shell",
  todowrite: "task",
  todoread: "task",
  task: "task",
  taskcreate: "task",
  taskupdate: "task",
  tasklist: "task",
  agent: "agent",
  askuserquestion: "hitl",
  skill: "generic",
  workflow: "generic",
  schedulewakeup: "generic",
  enterplanmode: "generic",
  exitplanmode: "generic",
  // Codex CLI
  exec: "shell",
  shell: "shell",
  shell_command: "shell",
  exec_command: "shell",
  write_stdin: "shell",
  update_plan: "task",
  view_image: "read",
  apply_patch: "write",
  request_user_input: "hitl",
  list_mcp_resources: "generic",
  list_mcp_resource_templates: "generic",
  read_mcp_resource: "generic",
  // Cursor CLI
  strreplace: "write",
  multistrreplace: "write",
  delete: "write",
  ls: "shell",
  readlints: "diagnostic",
  semanticsearch: "search",
  askquestion: "hitl",
}

const kindByName = (name: string): ToolKind => KIND_BY_NAME[name.toLowerCase()] ?? "generic"

/**
 * MCP tools are an open namespace, not a finite list, so they are matched by a
 * prefix rule rather than enumerated in the catalog: `mcp__<server>__<tool>`
 * (Claude/Codex) or `mcp_<server>_<tool>` (Cursor's flattened form). Anchored at
 * the start so a name that merely contains "mcp" is not misclassified.
 */
export const isMcpTool = (name: string): boolean => name.startsWith("mcp__") || name.startsWith("mcp_")

/**
 * The catalog rows: every first-party (provider, tool) we know about, paired
 * with the renderer its args flow through. `render` is the only hand-authored
 * axis — `kind` is derived from {@link KIND_BY_NAME} so the two can't drift. MCP
 * tools are intentionally absent (covered by {@link isMcpTool}).
 */
const SPECS: ReadonlyArray<{ provider: Provider; name: string; render: RenderShape }> = [
  // ── Claude Code ──────────────────────────────────────────────────────────
  { provider: "claude", name: "Bash", render: "shell" },
  { provider: "claude", name: "BashOutput", render: "fallback" },
  { provider: "claude", name: "KillShell", render: "fallback" },
  { provider: "claude", name: "Read", render: "path" },
  { provider: "claude", name: "NotebookRead", render: "path" },
  { provider: "claude", name: "Write", render: "write" },
  { provider: "claude", name: "Edit", render: "diff" },
  { provider: "claude", name: "MultiEdit", render: "fallback" },
  { provider: "claude", name: "NotebookEdit", render: "fallback" },
  { provider: "claude", name: "Glob", render: "path" },
  { provider: "claude", name: "Grep", render: "path" },
  { provider: "claude", name: "WebFetch", render: "fallback" },
  { provider: "claude", name: "WebSearch", render: "fallback" },
  { provider: "claude", name: "ToolSearch", render: "fallback" },
  { provider: "claude", name: "Agent", render: "fallback" },
  { provider: "claude", name: "Task", render: "fallback" },
  { provider: "claude", name: "TaskCreate", render: "fallback" },
  { provider: "claude", name: "TaskUpdate", render: "fallback" },
  { provider: "claude", name: "TaskList", render: "fallback" },
  { provider: "claude", name: "TodoWrite", render: "fallback" },
  { provider: "claude", name: "Skill", render: "fallback" },
  { provider: "claude", name: "Workflow", render: "fallback" },
  { provider: "claude", name: "ScheduleWakeup", render: "fallback" },
  { provider: "claude", name: "EnterPlanMode", render: "fallback" },
  { provider: "claude", name: "ExitPlanMode", render: "fallback" },
  { provider: "claude", name: "AskUserQuestion", render: "fallback" },
  // ── Codex CLI ────────────────────────────────────────────────────────────
  { provider: "codex", name: "exec", render: "shell" },
  { provider: "codex", name: "exec_command", render: "shell" },
  { provider: "codex", name: "shell", render: "shell" },
  { provider: "codex", name: "write_stdin", render: "fallback" },
  { provider: "codex", name: "apply_patch", render: "diff" },
  { provider: "codex", name: "update_plan", render: "fallback" },
  { provider: "codex", name: "view_image", render: "path" },
  { provider: "codex", name: "request_user_input", render: "fallback" },
  // ── Cursor CLI ───────────────────────────────────────────────────────────
  { provider: "cursor", name: "Shell", render: "shell" },
  { provider: "cursor", name: "Read", render: "path" },
  { provider: "cursor", name: "Write", render: "write" },
  { provider: "cursor", name: "StrReplace", render: "diff" },
  { provider: "cursor", name: "MultiStrReplace", render: "fallback" },
  { provider: "cursor", name: "Delete", render: "path" },
  { provider: "cursor", name: "Glob", render: "path" },
  { provider: "cursor", name: "Grep", render: "path" },
  { provider: "cursor", name: "SemanticSearch", render: "fallback" },
  { provider: "cursor", name: "WebFetch", render: "fallback" },
  { provider: "cursor", name: "WebSearch", render: "fallback" },
  { provider: "cursor", name: "TodoWrite", render: "fallback" },
  { provider: "cursor", name: "Task", render: "fallback" },
  { provider: "cursor", name: "ReadLints", render: "fallback" },
  { provider: "cursor", name: "AskQuestion", render: "fallback" },
  // ── pi (local) ───────────────────────────────────────────────────────────
  { provider: "pi", name: "bash", render: "shell" },
  { provider: "pi", name: "read", render: "path" },
  { provider: "pi", name: "write", render: "write" },
  { provider: "pi", name: "edit", render: "diff" },
  { provider: "pi", name: "ls", render: "path" },
  { provider: "pi", name: "grep", render: "path" },
  { provider: "pi", name: "find", render: "path" },
]

export const TOOL_CATALOG: ReadonlyArray<ToolEntry> = SPECS.map((spec) => ({
  provider: spec.provider,
  name: spec.name,
  kind: kindByName(spec.name),
  render: spec.render,
}))

const byKey = new Map<string, ToolEntry>(TOOL_CATALOG.map((entry) => [`${entry.provider}:${entry.name.toLowerCase()}`, entry]))

/** Look up a catalog row for an exact (provider, tool). MCP tools are never rows. */
export const lookupTool = (provider: Provider, name: string): ToolEntry | undefined =>
  byKey.get(`${provider}:${name.toLowerCase()}`)

/**
 * Map a provider-native tool name to its coarse {@link ToolKind}. MCP prefix
 * wins; then the catalog row; then the provider-agnostic name fallback. Results
 * match the legacy provider-agnostic classifier for every existing name, so the
 * stored `kind` column is unchanged.
 */
export const classifyTool = (provider: Provider | undefined, name: string | null | undefined): ToolKind => {
  if (!name) return "unknown"
  if (isMcpTool(name.toLowerCase())) return "mcp"
  return (provider ? lookupTool(provider, name)?.kind : undefined) ?? kindByName(name)
}

/**
 * Which renderer a (provider, tool)'s args flow through. MCP and unknown tools
 * fall back. `provider` is absent only for a row with no target session — with
 * no provider there is no catalog row to key, so it honestly falls back to JSON
 * rather than guessing a shape from the name alone.
 */
export const renderShapeFor = (provider: Provider | undefined, name: string | null | undefined): RenderShape => {
  if (!provider || !name || isMcpTool(name.toLowerCase())) return "fallback"
  return lookupTool(provider, name)?.render ?? "fallback"
}
