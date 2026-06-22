import type { JSX } from "react"
import type { WorkId } from "../../../../shared/ids.js"
import type { Provider } from "../../../../shared/provider.js"
import type { ToolCall as ToolCallData } from "../../../../shared/tool-call.js"
import { useShellActions } from "../../shell/ShellActionsContext.js"
import { arcResultSupersedesInput, arcToolBody, arcToolLabel, arcToolOutput, isArcTool } from "./arc-tool-body.js"
import { chromeToolBody, chromeToolLabel, isChromeTool } from "./chrome-tool-body.js"
import { CodeBlock, FLAG, flagsFor, formatArgs, toolBody } from "./tool-body.js"
import { renderShapeFor } from "../../../../shared/tool-catalog.js"

const CARD = "grid gap-2 min-w-0"
const HEAD = "flex items-center justify-between gap-2"
const TITLE = "flex items-baseline gap-1.5 min-w-0"
const TOOL = "font-mono text-xs font-semibold text-foreground truncate"
const STATUS =
  "flex-none px-1.5 py-px border border-border rounded-[var(--radius)] font-mono text-[9px] font-semibold uppercase tracking-[0.07em] whitespace-nowrap text-fg-dim"

// The plain success case ("output-available") gets no badge — it's the default
// outcome and the label is just noise. Only states that need attention show one.
const STATE_LABEL: Partial<Record<ToolCallData["state"], string>> = {
  "input-available": "input",
  "approval-requested": "awaiting approval",
  "output-error": "error",
  "output-denied": "denied",
}

export function ToolCall({
  tool,
  provider,
}: {
  readonly tool: ToolCallData
  readonly provider?: Provider
}): JSX.Element {
  const { open } = useShellActions()
  const openWork = (workId: WorkId): void => open({ kind: "work", workId }, "right")
  const flags = flagsFor(tool.args)
  // Arc's own MCP toolkit (`mcp__arc__arc_*`) gets dedicated work/comment/search
  // cards rather than the generic MCP raw-JSON fallback — we know its exact
  // domain shapes. Everything else uses the catalog-driven per-tool rendering the
  // permission card uses (Bash command, Write body, Edit diff, file path), with
  // raw JSON only when no shape matched. `provider` comes from the envelope.
  const arc = isArcTool(tool.toolName)
  // The Claude-in-Chrome MCP toolkit gets its own action cards (navigate URL,
  // click target, script) the same way arc does — another MCP namespace whose
  // arg shapes we model, so it skips the generic raw-JSON fallback.
  const chrome = !arc && isChromeTool(tool.toolName)
  // For work create/update/get (and an arc.get entity batch) the result card is the
  // canonical line; the authored input echo would just duplicate it, so render the
  // result alone once it lands.
  const supersededByResult = arc && tool.output ? arcResultSupersedesInput(tool.output) : false
  const body =
    arc
      ? supersededByResult
        ? null
        : arcToolBody(tool.toolName, tool.args, openWork)
      : chrome
        ? chromeToolBody(tool.toolName, tool.args)
        : toolBody(provider, tool.toolName, tool.args)
  const fallback = body || supersededByResult ? null : formatArgs(tool.args)
  const outputCard = arc && tool.output ? arcToolOutput(tool.output, openWork) : null
  // The diff body already shows what changed; an Edit/patch's "file updated"
  // success text is pure noise, so drop the raw output block for diff tools.
  const isDiff = !arc && renderShapeFor(provider, tool.toolName) === "diff"
  return (
    <div className={CARD}>
      <div className={HEAD}>
        <span className={TITLE}>
          <span className={TOOL}>{arc ? arcToolLabel(tool.toolName) : chrome ? chromeToolLabel(tool.toolName) : tool.toolName}</span>
          {flags.map((flag) => (
            <span key={flag} className={FLAG}>
              {flag}
            </span>
          ))}
        </span>
        {STATE_LABEL[tool.state] && <span className={STATUS}>{STATE_LABEL[tool.state]}</span>}
      </div>
      {body}
      {fallback && <CodeBlock text={fallback} />}
      {outputCard ?? (!isDiff && tool.output ? <CodeBlock text={tool.output} /> : null)}
    </div>
  )
}
