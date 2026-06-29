import type { Work } from "../../shared/work.js"

/**
 * The exact tool name a spawned provider's model sees for an `arc.<verb>` MCP
 * tool. Every client collapses the dotted MCP name to `arc_<verb>` and
 * namespaces the server its own way, so a prompt that names a tool in prose must
 * use that client's flattened string — otherwise the model is told to call
 * `arc.prime` while its tool list only holds `mcp__arc__arc_prime`, and (esp.
 * weaker models like Cursor's Composer) decides the tool is missing and shells
 * out to `arc`. This is the forward of the renderer's `arc-tool-name.ts`
 * parsing; keep the two prefix lists in sync.
 */
export const mcpToolName = (provider: string, dottedName: string): string => {
  const base = dottedName.replaceAll(".", "_") // arc.work.update -> arc_work_update
  switch (provider) {
    case "claude":
      return `mcp__arc__${base}`
    case "cursor":
      return `mcp_plugin-arc-work-arc_${base}` // orchestrated per-session plugin dir
    default:
      return base // codex, pi: server prefix only, no client namespace
  }
}

/**
 * Orchestration priming, pushed into the spawn prompt rather than pulled via a
 * SessionStart hook: prepend the assigned work to the caller's instructions so a
 * freshly launched agent starts already oriented on what it was delegated. The
 * prompt is delivered by each provider's normal injection (cursor stdin paste,
 * claude `--prefill`, …); `arc.prime` stays available for an already-running
 * agent to re-fetch the same context on demand.
 *
 * The wording is deliberately blunt and MCP-first: weaker models (e.g. Cursor's
 * Composer) otherwise grep the repo for `arc.prime`, or try to run it as a shell
 * command (`which arc; arc prime`), instead of invoking it as the MCP tool it is.
 *
 * `parentTargetId` is the orchestrator's own target id (the spawn caller's MCP
 * provenance). When present we hand the child a direct line home: `arc.work.update`
 * is the durable record, but `arc.agent.send` to the parent is the attention path
 * — a question, a blocker, or a finished result that lands in the orchestrator's
 * own next turn instead of waiting to be polled off the work item.
 */
export const buildOrchestrationPrompt = (
  provider: string,
  work: Work,
  instructions: string | undefined,
  parentTargetId: string | undefined,
): string => {
  const name = (verb: string): string => mcpToolName(provider, verb)
  // Only advertise the back-channel when we know who to address; an un-parented
  // spawn (no caller provenance) has no orchestrator to message.
  const tools = [name("arc.prime"), name("arc.work.update"), name("arc.get"), name("arc.search")]
  if (parentTargetId) tools.push(name("arc.agent.send"))
  const toolsPhrase =
    tools.slice(0, -1).map((t) => `\`${t}\``).join(", ") + `, and \`${tools.at(-1)}\``
  const header =
    "You are an agent spawned by Arc Work to carry out an assigned unit of work. " +
    `Arc gives you ${toolsPhrase} as ` +
    "MCP TOOLS in your available-tools list — already connected in this session. " +
    "They are NOT shell commands: there is no `arc` CLI, so never run `arc ...` in a " +
    "terminal, and never grep or list the repo to check whether they exist. Invoke " +
    "them directly as tool calls by these exact names. If a call is rejected or " +
    "errors, stop and report the exact error; never conclude the tools are missing."
  const parentStep = parentTargetId
    ? `\n4. You were spawned by an orchestrator (target session \`${parentTargetId}\`). To ask it a ` +
      `question, flag a blocker, or hand back your result, invoke the \`${name("arc.agent.send")}\` ` +
      `tool with \`targetSessionId: "${parentTargetId}"\`. \`${name("arc.work.update")}\` is the durable ` +
      `record; \`${name("arc.agent.send")}\` reaches the orchestrator directly so it sees you in its next turn.`
    : ""
  const steps =
    "Do these in order:\n" +
    `1. Invoke the \`${name("arc.prime")}\` tool FIRST to load your full assignment and context.\n` +
    "2. Carry out the work.\n" +
    `3. Invoke the \`${name("arc.work.update")}\` tool as you go — comment on progress and ` +
    "blockers, and set status to `done` only once the work is actually complete. " +
    `Reporting back via \`${name("arc.work.update")}\` is part of finishing, not optional.` +
    parentStep +
    `\n(The \`${name("arc.search")}\` / \`${name("arc.get")}\` tools read the work graph if you need more context.)`
  const assignment = `Assigned work ${work.id} [${work.priority}/${work.status}]: ${work.title}\n\n${work.body}`
  const task = instructions?.trim()
  return [header, steps, assignment, task ? `Task:\n${task}` : undefined].filter(Boolean).join("\n\n")
}
