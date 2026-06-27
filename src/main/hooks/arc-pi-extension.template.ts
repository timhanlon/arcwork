// Bridges the arc.* toolkit into pi as native tools and relays pi's lifecycle to
// Arc's hook socket. Wiring is read from the Arc env (ARC_MCP_TOKEN / ARC_DB_PATH
// / ARC_HOOK_SOCK / ARC_CHAT_ID / ARC_TARGET_SESSION_ID).
//
// This file is shipped to pi verbatim (inlined `?raw` into the Arc bundle, then
// written to the profile runtime dir at launch). It runs in *pi's* runtime, not
// Arc's — pi's loader strips the type-only imports below, and `typebox` resolves
// from pi's own bundle. The types here exist purely so Arc's `tsc` checks this
// against pi's real extension contract.
import type { AgentToolResult, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { Type } from "typebox"
import net from "node:net"
import { readFileSync } from "node:fs"
import { dirname, join } from "node:path"

const env = process.env
const mcpToken = env["ARC_MCP_TOKEN"]
const arcDbPath = env["ARC_DB_PATH"]
const hookSock = env["ARC_HOOK_SOCK"]
const chatId = env["ARC_CHAT_ID"] ?? null
const targetSessionId = env["ARC_TARGET_SESSION_ID"] ?? null
const ARC_PROTOCOL = "2025-06-18"

const readMcpUrl = (): string | null => {
  if (!arcDbPath) return null
  try {
    const ep = JSON.parse(readFileSync(join(dirname(arcDbPath), "arc-mcp.json"), "utf8"))
    return typeof ep.url === "string" ? ep.url : null
  } catch {
    return null
  }
}
const parseMcpPayload = (text: string): { result?: unknown; error?: { message?: string } } | null => {
  // SSE may emit progress events before the result; return the data line that
  // carries the JSON-RPC response (result/error), not just the first one.
  const datas = text.split("\n").filter((l) => l.startsWith("data:"))
  for (const line of datas.length ? datas : [text]) {
    try {
      const obj = JSON.parse(line.replace(/^data:\s*/, ""))
      if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj
    } catch {}
  }
  return null
}
const mcpHeaders = (sessionId?: string | null): Record<string, string> => ({
  "content-type": "application/json",
  accept: "application/json, text/event-stream",
  "mcp-protocol-version": ARC_PROTOCOL,
  ...(mcpToken ? { authorization: "Bearer " + mcpToken } : {}),
  ...(sessionId ? { "mcp-session-id": sessionId } : {}),
})
const post = async (url: string, body: unknown, sessionId?: string | null) => {
  const res = await fetch(url, {
    method: "POST",
    headers: mcpHeaders(sessionId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(20000),
  })
  return { sessionId: res.headers.get("mcp-session-id"), text: await res.text() }
}
let session: string | null = null
let nextId = 1
const ensureSession = async (url: string): Promise<string | undefined> => {
  if (session) return session
  const init = await post(url, {
    jsonrpc: "2.0",
    id: nextId++,
    method: "initialize",
    params: { protocolVersion: ARC_PROTOCOL, capabilities: {}, clientInfo: { name: "arc-pi-connector", version: "1" } },
  })
  session = init.sessionId
  if (session) await post(url, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, session)
  return session ?? undefined
}
const callArcTool = async (name: string, args: unknown): Promise<unknown> => {
  const url = readMcpUrl()
  if (!url) throw new Error("arc MCP endpoint not found (need ARC_DB_PATH next to arc-mcp.json)")
  const sid = await ensureSession(url)
  const res = await post(url, { jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }, sid)
  const payload = parseMcpPayload(res.text)
  if (payload?.error) throw new Error(payload.error.message ?? JSON.stringify(payload.error))
  const result = payload?.result as { structuredContent?: unknown; content?: unknown } | undefined
  return result?.structuredContent ?? result?.content ?? result
}

// pi's own session id (the uuid in its session-file name == the `session` entry
// id the transcript parser keys on). Relaying it lets Arc bind the target to this
// native session, so ingested rows match exactly instead of via the unbound
// fallback (important once a chat has more than one pi agent).
let piSessionId: string | null = null
let piSessionFile: string | null = null
const refreshSessionId = (ctx: ExtensionContext): void => {
  try {
    const f = ctx.sessionManager.getSessionFile()
    if (typeof f === "string") {
      piSessionFile = f
      const m = f.match(/_([0-9a-f-]+)\.jsonl$/)
      if (m) piSessionId = m[1] ?? null
    }
  } catch {}
}

const relayHook = (eventName: string): void => {
  if (!hookSock) return
  const record = {
    schemaVersion: 1,
    helperVersion: 1,
    declaredProvider: "pi",
    declaredEvent: eventName,
    observedAt: new Date().toISOString(),
    cwd: process.cwd(),
    pid: process.pid,
    native: { sessionId: piSessionId, transcriptPath: piSessionFile, hookEventName: eventName },
    sessionId: piSessionId,
    arc: { chatId, targetSessionId, targetProvider: "pi", hookSockPresent: true },
    provider: "pi",
    event: eventName,
  }
  try {
    const c = net.createConnection(hookSock)
    c.on("connect", () => c.end(JSON.stringify(record) + "\n"))
    c.on("error", () => {})
  } catch {}
}

export default function (pi: ExtensionAPI): void {
  pi.on("session_start", (_e, ctx) => { refreshSessionId(ctx); relayHook("SessionStart") })
  pi.on("agent_start", (_e, ctx) => { refreshSessionId(ctx); relayHook("UserPromptSubmit") })
  pi.on("agent_end", (_e, ctx) => { refreshSessionId(ctx); relayHook("Stop") })
  pi.on("session_shutdown", (_e, ctx) => { refreshSessionId(ctx); relayHook("SessionEnd") })

  const ok = (value: unknown): AgentToolResult<unknown> => ({ content: [{ type: "text", text: JSON.stringify(value, null, 2) }], details: {} })
  const fail = (e: unknown): AgentToolResult<unknown> => ({ content: [{ type: "text", text: "arc tool error: " + (e instanceof Error ? e.message : String(e)) }], details: {} })

  pi.registerTool({
    name: "arc_prime",
    label: "Arc: prime",
    description: "Load your Arc assignment and context (work delegated to you, your chat/session). Call this first.",
    parameters: Type.Object({}),
    async execute() {
      try { return ok(await callArcTool("arc.prime", {})) } catch (e) { return fail(e) }
    },
  })
  pi.registerTool({
    name: "arc_work_update",
    label: "Arc: update work",
    description: "Report progress on an Arc work item: add a comment and/or move its status (open|active|blocked|done).",
    parameters: Type.Object({
      workRefId: Type.String({ description: "the work_… id" }),
      status: Type.Optional(Type.String({ description: "open | active | blocked | done" })),
      comment: Type.Optional(Type.String({ description: "progress note" })),
    }),
    async execute(_id, params) {
      try {
        return ok(await callArcTool("arc.work.update", {
          workRefId: params.workRefId,
          ...(params.status ? { set: { status: params.status } } : {}),
          ...(params.comment ? { addComment: { body: params.comment, ref: true } } : {}),
        }))
      } catch (e) { return fail(e) }
    },
  })
  pi.registerTool({
    name: "arc_agent_spawn",
    label: "Arc: spawn agent",
    description: "Spawn a new provider-backed Arc agent (target session) to delegate work to. Returns the new agent's target session id — message it later with arc_agent_send. To have the new agent report back to you, call arc_prime first for your own target.id and pass it in its instructions.",
    parameters: Type.Object({
      provider: Type.String({ description: "provider to launch, e.g. pi" }),
      instructions: Type.Optional(Type.String({ description: "task/prompt for the new agent" })),
      preset: Type.Optional(Type.String({ description: "model/preset for the new agent" })),
      workRefId: Type.Optional(Type.String({ description: "a work_… id to durably assign to the new agent" })),
    }),
    async execute(_id, params) {
      try { return ok(await callArcTool("arc.agent.spawn", params)) } catch (e) { return fail(e) }
    },
  })
  pi.registerTool({
    name: "arc_agent_send",
    label: "Arc: message agent",
    description: "Send a message into another running Arc agent (target session).",
    parameters: Type.Object({ targetSessionId: Type.String(), body: Type.String() }),
    async execute(_id, params) {
      try { return ok(await callArcTool("arc.agent.send", params)) } catch (e) { return fail(e) }
    },
  })
  pi.registerTool({
    name: "arc_search",
    label: "Arc: search",
    description: "Search Arc's work graph in your workspace.",
    parameters: Type.Object({ query: Type.Optional(Type.String()) }),
    async execute(_id, params) {
      try { return ok(await callArcTool("arc.search", params.query ? { query: params.query } : {})) } catch (e) { return fail(e) }
    },
  })
  pi.registerTool({
    name: "arc_get",
    label: "Arc: get",
    description: "Hydrate an Arc ref (work_…, chat_…, message_…) to its full object.",
    parameters: Type.Object({ ref: Type.String() }),
    async execute(_id, params) {
      try { return ok(await callArcTool("arc.get", { ref: params.ref })) } catch (e) { return fail(e) }
    },
  })
}
