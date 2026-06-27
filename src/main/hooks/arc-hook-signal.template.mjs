// @ts-check
// Invoked by a target CLI hook: `node <this> <provider> <event>`. Connects to the
// injected unix socket and writes one JSON line with the raw hook payload +
// inherited Arc tags, then exits 0 — hooks must never block or fail the CLI.
//
// Authored as real, JS-valid typed code (JSDoc + `// @ts-check`) and inlined
// `?raw` into the Arc bundle (see install.ts), then written verbatim to the
// profile runtime dir at launch. It runs under plain `node`, so it must stay
// valid JS — no TypeScript syntax. The `ARC_*` env var names are literals
// mirrored from shared/env-tags.ts; SCHEMA_VERSION / HELPER_VERSION are kept in
// sync with HOOK_SIGNAL_*_VERSION in signals.ts (guarded by hook-helper.test.ts).
import net from "node:net"
import { createHash } from "node:crypto"
import { dirname, join } from "node:path"
import { readFileSync } from "node:fs"

const SCHEMA_VERSION = 1
const HELPER_VERSION = 4
const sock = process.env["ARC_HOOK_SOCK"]
const [, , declaredProvider = "unknown", declaredEvent = "unknown"] = process.argv
const mcpToken = process.env["ARC_MCP_TOKEN"]
const arcDbPath = process.env["ARC_DB_PATH"]

/** @type {Buffer[]} */
const chunks = []
for await (const chunk of process.stdin) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk)
const stdinBytes = Buffer.concat(chunks)
const stdinText = stdinBytes.toString("utf8")

/** @param {unknown} v @returns {v is Record<string, unknown>} */
const isRecord = (v) => typeof v === "object" && v !== null && !Array.isArray(v)
/** @param {unknown} v @returns {string | null} */
const str = (v) => (typeof v === "string" && v.length > 0 ? v : null)
/** @param {Record<string, unknown> | null} obj @param {string[]} keys @returns {string | null} */
const firstStr = (obj, keys) => {
  if (!isRecord(obj)) return null
  for (const key of keys) {
    const v = str(obj[key])
    if (v) return v
  }
  return null
}

/** @type {unknown} */
let hookInput = stdinText
let hookInputParseOk = false
try {
  hookInput = JSON.parse(stdinText)
  hookInputParseOk = true
} catch {
  // non-JSON stdin: keep the raw text and flag the parse as failed
}

const hookInputObj = isRecord(hookInput) ? hookInput : null
const native = {
  sessionId: firstStr(hookInputObj, ["session_id", "sessionId", "sessionID"]),
  transcriptPath: firstStr(hookInputObj, ["transcript_path", "transcriptPath"]),
  conversationId: firstStr(hookInputObj, ["conversation_id", "conversationId"]),
  turnId: firstStr(hookInputObj, ["turn_id", "turnId"]),
  toolUseId: firstStr(hookInputObj, ["tool_use_id", "toolUseId"]),
  hookEventName: firstStr(hookInputObj, ["hook_event_name", "hookEventName"]),
  model: str(hookInputObj?.["model"]),
}

const record = {
  schemaVersion: SCHEMA_VERSION,
  helperVersion: HELPER_VERSION,
  declaredProvider,
  declaredEvent,
  observedAt: new Date().toISOString(),
  cwd: process.cwd(),
  pid: process.pid,
  argv: process.argv,
  hookInput,
  hookInputParseOk,
  hookInputSha256: createHash("sha256").update(stdinBytes).digest("hex"),
  native,
  arc: {
    chatId: process.env["ARC_CHAT_ID"] ?? null,
    targetSessionId: process.env["ARC_TARGET_SESSION_ID"] ?? null,
    targetProvider: process.env["ARC_TARGET_PROVIDER"] ?? null,
    hookSockPresent: Boolean(sock),
  },
  // Legacy flat fields for transitional readers.
  provider: declaredProvider,
  event: declaredEvent,
  at: new Date().toISOString(),
  sessionId: native.sessionId ?? native.conversationId,
  arcChatSessionId: process.env["ARC_CHAT_ID"] ?? null,
  arcTargetSessionId: process.env["ARC_TARGET_SESSION_ID"] ?? null,
  arcTargetProvider: process.env["ARC_TARGET_PROVIDER"] ?? null,
}

if (sock) {
  await new Promise((resolve) => {
    const c = net.createConnection(sock)
    c.on("connect", () => c.end(JSON.stringify(record) + "\n"))
    c.on("close", resolve)
    c.on("error", resolve) // best-effort: never block the CLI
  })
}

/** @param {string} text @returns {{ result?: any, error?: any } | null} */
const parseMcpPayload = (text) => {
  // SSE may emit progress events before the result; return the data line that
  // carries the JSON-RPC response (result/error), not just the first one.
  const datas = text.split("\n").filter((line) => line.startsWith("data:"))
  for (const line of datas.length ? datas : [text]) {
    try {
      const obj = JSON.parse(line.replace(/^data:\s*/, ""))
      if (obj && (obj.result !== undefined || obj.error !== undefined)) return obj
    } catch {
      // skip a non-JSON SSE line and try the next
    }
  }
  return null
}

/** @returns {string | null} */
const readMcpUrl = () => {
  if (!arcDbPath) return null
  try {
    const endpoint = JSON.parse(readFileSync(join(dirname(arcDbPath), "arc-mcp.json"), "utf8"))
    return typeof endpoint.url === "string" ? endpoint.url : null
  } catch {
    return null
  }
}

/**
 * @param {string} url
 * @param {unknown} body
 * @param {string | null} [sessionId]
 * @param {AbortSignal | null} [signal]
 */
const postMcp = async (url, body, sessionId = null, signal = null) => {
  const headers = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
    ...(mcpToken ? { authorization: "Bearer " + mcpToken } : {}),
    ...(sessionId ? { "mcp-session-id": sessionId } : {}),
  }
  const res = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: signal ?? AbortSignal.timeout(1500),
  })
  return { sessionId: res.headers.get("mcp-session-id"), text: await res.text() }
}

const maybePrime = async () => {
  const event = String(native.hookEventName ?? declaredEvent).toLowerCase()
  if (event !== "sessionstart" && event !== "session_start") return
  const url = readMcpUrl()
  if (!url) return
  // One overall budget across all three priming round-trips, so a slow/unresponsive
  // MCP server can't hold the provider's SessionStart hook open for 3×1500ms.
  // Priming is best-effort (the spawn prompt also carries it), so if the budget
  // blows we just skip and let the provider start.
  const deadline = AbortSignal.timeout(2000)
  try {
    const init = await postMcp(
      url,
      {
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "arc-hook-prime", version: String(HELPER_VERSION) },
        },
      },
      null,
      deadline,
    )
    const sessionId = init.sessionId
    if (!sessionId) return
    await postMcp(url, { jsonrpc: "2.0", method: "notifications/initialized", params: {} }, sessionId, deadline)
    const prime = await postMcp(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "arc.prime", arguments: {} } },
      sessionId,
      deadline,
    )
    const payload = parseMcpPayload(prime.text)
    const context = payload?.result?.structuredContent
    if (context) {
      // Provider hooks (Claude Code, Codex) share one SessionStart output schema:
      // the context must ride under hookSpecificOutput.additionalContext. A bare
      // top-level field is rejected as "invalid session start JSON output".
      process.stdout.write(
        JSON.stringify({
          hookSpecificOutput: {
            hookEventName: "SessionStart",
            additionalContext: "Arc prime context from MCP arc.prime:\n" + JSON.stringify(context, null, 2),
          },
        }) + "\n",
      )
    }
  } catch {
    // best-effort: priming must never block or fail the provider hook
  }
}

await maybePrime()
process.exit(0)
