import type { ReactNode } from "react"
import type { Provider } from "../../../../shared/provider.js"
import type { ToolCall as ToolCallData } from "../../../../shared/tool-call.js"
import { TOOL_CATALOG, type ToolEntry } from "../../../../shared/tool-catalog.js"
import { sampleKey, TOOL_SAMPLES } from "../../../../shared/tool-catalog.samples.js"
import { ToolCall } from "./ToolCall.js"

// Catalog-driven: every (provider, tool) row arc knows about renders here from
// its sample, so coverage tracks the catalog automatically — a new tool with a
// sample shows up with no story edit. The caption surfaces each row's render
// shape + kind, making the "do we have dedicated rendering?" matrix visible
// (rows tagged `fallback` are the raw-JSON ones still wanting a dedicated view).
export default {
  title: "Chat / ToolCall",
}

// Mirrors the `tool`-role transcript row from Message.tsx: flat on the pane
// background now, no card border or surface — the inner code/output panel is the
// only frame.
const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 460, maxWidth: "100%" }}>{children}</div>
)

const Caption = ({ entry }: { readonly entry: ToolEntry }) => (
  <div
    style={{
      display: "flex",
      gap: 8,
      alignItems: "baseline",
      marginBottom: 6,
      fontFamily: "var(--font-mono, monospace)",
      fontSize: 11,
    }}
  >
    <span style={{ fontWeight: 600, color: "var(--foreground)" }}>{entry.name}</span>
    <span style={{ color: entry.render === "fallback" ? "var(--fg-faint)" : "var(--fg-dim)" }}>
      {entry.render}
    </span>
    <span style={{ color: "var(--fg-faint)" }}>{entry.kind}</span>
  </div>
)

const toolFor = (entry: ToolEntry): ToolCallData => {
  const sample = TOOL_SAMPLES[sampleKey(entry.provider, entry.name)]
  return {
    kind: "tool",
    state: "output-available",
    toolName: entry.name,
    ...(sample && sample.args !== undefined ? { args: sample.args } : {}),
    ...(sample?.output ? { output: sample.output } : {}),
  }
}

const Grid = ({ provider }: { readonly provider: Provider }) => (
  <div style={{ display: "grid", gap: 22 }}>
    {TOOL_CATALOG.filter((entry) => entry.provider === provider).map((entry) => (
      <div key={entry.name}>
        <Caption entry={entry} />
        <Frame>
          <ToolCall tool={toolFor(entry)} provider={entry.provider} />
        </Frame>
      </div>
    ))}
  </div>
)

/** Every Claude Code tool, each rendered from its catalog sample. */
export const Claude = () => <Grid provider="claude" />

/** Every Codex tool, each rendered from its catalog sample. */
export const Codex = () => <Grid provider="codex" />

/** Every Cursor tool, each rendered from its catalog sample. */
export const Cursor = () => <Grid provider="cursor" />

// One tool across the call lifecycle — the states are orthogonal to the catalog,
// so they stay a hand-authored set rather than a per-tool grid.
const stateExamples: ReadonlyArray<{ readonly label: string; readonly tool: ToolCallData }> = [
  {
    label: "input-available (pending, background flag)",
    tool: { kind: "tool", state: "input-available", toolName: "Bash", args: { command: "sleep 30 && echo done", run_in_background: true } },
  },
  {
    label: "output-denied",
    tool: { kind: "tool", state: "output-denied", toolName: "Bash", args: { command: "rm -rf build" }, output: "The user doesn't want to proceed with this tool use." },
  },
  {
    label: "output-error",
    tool: { kind: "tool", state: "output-error", toolName: "Bash", args: { command: "exit 1" }, output: "[error] command failed with exit code 1" },
  },
]

/** The call-state pills (pending / denied / error) on one representative tool. */
export const States = () => (
  <div style={{ display: "grid", gap: 22 }}>
    {stateExamples.map(({ label, tool }) => (
      <div key={label}>
        <div style={{ marginBottom: 6, fontFamily: "var(--font-mono, monospace)", fontSize: 11, color: "var(--fg-dim)" }}>
          {label}
        </div>
        <Frame>
          <ToolCall tool={tool} provider="claude" />
        </Frame>
      </div>
    ))}
  </div>
)
