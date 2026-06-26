import Sqlite from "better-sqlite3"
import { readHeadlessLatest, type HeadlessLatest } from "./headless-latest.js"

/**
 * `arc-drive` — a thin CLI for driving and observing the `arc-headless` harness,
 * so a human (or an agent) never hand-rolls an MCP client, mints a bearer, or
 * pokes the temp sqlite by hand again. It auto-discovers the live harness from
 * the well-known `headless-latest.json` the harness publishes on boot; every
 * coordinate can still be overridden with a flag.
 *
 *   ELECTRON_RUN_AS_NODE=1 electron out/main/arc-drive.js <command> [args]
 *   (or `pnpm drive <command> [args]`)
 *
 * Commands:
 *   tools                                  list the MCP tools the server advertises
 *   prime                                  call arc.prime as the driver
 *   spawn <provider> [opts]                arc.agent.spawn (--preset --instructions --work --cols --rows)
 *   send  <targetId> <body...> [--from f]  arc.agent.send into a running target
 *   observe                                dump target_sessions / chat_messages / tool_calls / target_messages
 *
 * Global overrides: --url <mcpUrl>  --db <dbPath>  --bearer <tok>  --chat <chatId>
 */

// ── argv ─────────────────────────────────────────────────────────────────────

interface Args {
  readonly command: string | undefined
  readonly positionals: ReadonlyArray<string>
  readonly flags: Readonly<Record<string, string>>
}

const parseArgs = (argv: ReadonlyArray<string>): Args => {
  const positionals: Array<string> = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a !== undefined && a.startsWith("--")) {
      const key = a.slice(2)
      const next = argv[i + 1]
      // `--flag value`; a bare trailing `--flag` becomes "true".
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next
        i++
      } else {
        flags[key] = "true"
      }
    } else if (a !== undefined) {
      positionals.push(a)
    }
  }
  return { command: positionals[0], positionals: positionals.slice(1), flags }
}

// ── coordinates ──────────────────────────────────────────────────────────────

const resolveCoords = (flags: Readonly<Record<string, string>>): HeadlessLatest => {
  const discovered = readHeadlessLatest()
  const mcpUrl = flags["url"] ?? discovered?.mcpUrl
  const bearer = flags["bearer"] ?? discovered?.bearer
  const dbPath = flags["db"] ?? discovered?.dbPath
  const chatId = flags["chat"] ?? discovered?.chatId
  if (!mcpUrl || !bearer || !dbPath || !chatId) {
    throw new Error(
      "no live harness found — start `arc-headless` first, or pass --url/--bearer/--db/--chat. " +
        `(read ${JSON.stringify(discovered)})`,
    )
  }
  return {
    mcpUrl,
    bearer,
    dbPath,
    chatId,
    cwd: discovered?.cwd ?? "",
    workspaceId: discovered?.workspaceId ?? "",
  }
}

// ── MCP client (streamable HTTP) ─────────────────────────────────────────────

interface JsonRpc {
  readonly id?: number
  readonly result?: unknown
  readonly error?: { readonly message?: string }
}

class McpClient {
  private sessionId: string | undefined
  private nextId = 1
  constructor(
    private readonly url: string,
    private readonly bearer: string,
  ) {}

  private async parse(res: Response): Promise<JsonRpc | undefined> {
    const text = await res.text()
    const ct = res.headers.get("content-type") ?? ""
    if (ct.includes("text/event-stream")) {
      // SSE may interleave progress events before the result; return the data
      // line that carries the JSON-RPC response (result/error), not just the first.
      let first: JsonRpc | undefined
      for (const line of text.split("\n")) {
        const t = line.trim()
        if (!t.startsWith("data:")) continue
        const payload = t.slice(5).trim()
        if (!payload) continue
        try {
          const obj = JSON.parse(payload) as JsonRpc
          first ??= obj
          if (obj.result !== undefined || obj.error !== undefined) return obj
        } catch {
          /* skip non-JSON data line */
        }
      }
      return first
    }
    return text ? (JSON.parse(text) as JsonRpc) : undefined
  }

  private async rpc(method: string, params?: unknown, notification = false): Promise<JsonRpc | undefined> {
    const body: Record<string, unknown> = { jsonrpc: "2.0", method }
    if (params !== undefined) body["params"] = params
    if (!notification) body["id"] = this.nextId++
    const headers: Record<string, string> = {
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      authorization: `Bearer ${this.bearer}`,
    }
    if (this.sessionId) headers["mcp-session-id"] = this.sessionId
    const res = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(body) })
    const sid = res.headers.get("mcp-session-id")
    if (sid) this.sessionId = sid
    return notification ? undefined : this.parse(res)
  }

  async connect(): Promise<void> {
    await this.rpc("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "arc-drive", version: "1" },
    })
    await this.rpc("notifications/initialized", {}, true)
  }

  async list(): Promise<ReadonlyArray<string>> {
    const out = await this.rpc("tools/list", {})
    const tools = (out?.result as { tools?: ReadonlyArray<{ name: string }> } | undefined)?.tools ?? []
    return tools.map((t) => t.name)
  }

  async call(name: string, args: Record<string, unknown>): Promise<unknown> {
    const out = await this.rpc("tools/call", { name, arguments: args })
    if (out?.error) throw new Error(out.error.message ?? "tool error")
    const result = out?.result as
      | { structuredContent?: unknown; content?: ReadonlyArray<{ text?: string }>; isError?: boolean }
      | undefined
    if (result?.structuredContent !== undefined) return result.structuredContent
    // Fall back to the text content block (and parse it if it's JSON).
    const text = result?.content?.[0]?.text
    if (text === undefined) return result
    try {
      return JSON.parse(text)
    } catch {
      return text
    }
  }
}

// ── observe ──────────────────────────────────────────────────────────────────

const observe = (dbPath: string): void => {
  const db = new Sqlite(dbPath, { readonly: true, fileMustExist: true })
  try {
    const dump = (title: string, sql: string): void => {
      const rows = db.prepare(sql).all()
      console.log(`\n=== ${title} (${rows.length}) ===`)
      for (const row of rows) console.log(JSON.stringify(row))
    }
    dump(
      "target_sessions",
      "select substr(id,1,24) id, provider, origin, state, native_session_id nsid, (native_transcript_path is not null) bound from target_sessions",
    )
    dump(
      "chat_messages",
      "select substr(id,1,22) id, role, status, substr(coalesce(body,''),1,70) body from chat_messages order by occurred_at",
    )
    dump(
      "tool_calls",
      "select substr(session_id,1,20) session, provider, name, substr(coalesce(output_text,''),1,50) output from tool_calls order by sequence",
    )
    dump(
      "target_messages",
      "select substr(target_session_id,1,24) target, substr(body,1,50) body, sender, (delivered_at is not null) delivered from target_messages order by created_at",
    )
  } finally {
    db.close()
  }
}

// ── commands ─────────────────────────────────────────────────────────────────

const main = async (): Promise<void> => {
  const { command, positionals, flags } = parseArgs(process.argv.slice(2))

  if (!command || command === "help") {
    console.log(
      "arc-drive <command>:\n" +
        "  tools | prime | observe\n" +
        "  spawn <provider> [--preset p --instructions s --work work_.. --cols n --rows n]\n" +
        "  send  <targetId> <body...> [--from name]\n" +
        "  overrides: --url --db --bearer --chat",
    )
    return
  }

  const coords = resolveCoords(flags)

  if (command === "observe") {
    observe(coords.dbPath)
    return
  }

  const client = new McpClient(coords.mcpUrl!, coords.bearer)
  await client.connect()

  switch (command) {
    case "tools":
      console.log(JSON.stringify(await client.list(), null, 2))
      break
    case "prime":
      console.log(JSON.stringify(await client.call("arc.prime", {}), null, 2))
      break
    case "spawn": {
      const provider = positionals[0]
      if (!provider) throw new Error("spawn requires a provider, e.g. `spawn pi --preset google/gemma-4-e4b`")
      const args: Record<string, unknown> = { provider, chatId: coords.chatId }
      if (flags["preset"]) args["preset"] = flags["preset"]
      if (flags["instructions"]) args["instructions"] = flags["instructions"]
      if (flags["work"]) args["workRefId"] = flags["work"]
      if (flags["cols"]) args["cols"] = Number(flags["cols"])
      if (flags["rows"]) args["rows"] = Number(flags["rows"])
      console.log(JSON.stringify(await client.call("arc.agent.spawn", args), null, 2))
      break
    }
    case "send": {
      const targetId = positionals[0]
      const body = positionals.slice(1).join(" ")
      if (!targetId || !body) throw new Error("send requires <targetId> <body...>")
      const args: Record<string, unknown> = { targetSessionId: targetId, body }
      if (flags["from"]) args["from"] = flags["from"]
      console.log(JSON.stringify(await client.call("arc.agent.send", args), null, 2))
      break
    }
    default:
      throw new Error(`unknown command: ${command}`)
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
