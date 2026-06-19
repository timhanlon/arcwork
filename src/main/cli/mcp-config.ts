/**
 * `arc-mcp` — turn the running app's MCP discovery file into ready-to-use client
 * config for an agent CLI (claude / cursor / codex), so connecting an implementer
 * is a command, not a hand-edit.
 *
 * This is the only surviving `arc-*` CLI: a small internal/debug utility. It never
 * opens the work DB — it only reads `arc-mcp.json` (published beside the profile's
 * `arc.sqlite` when the app launches) and writes provider config. The supported
 * write surfaces for the work graph are the renderer RPC seam and the in-process
 * MCP tools (`arc.work.*`), not a CLI.
 *
 * It resolves the same profile/DB path the app uses (inherited via `ARC_PROFILE` /
 * `ARC_DB_PATH` from the launching session — see db/paths.ts) so it finds the right
 * discovery file whether or not the app is open. Run via `ELECTRON_RUN_AS_NODE=1
 * electron out/main/cli-mcp.js` (see `bin/arc-mcp`) so it shares the app's bundle;
 * it needs no native modules, but the wrapper keeps one launch path.
 */
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { Predicate } from "effect"
import {
  MCP_PROVIDERS,
  type McpProvider,
  isMcpProvider,
  mergeArcServer,
  providerClientConfig,
} from "../mcp/client-config.js"
import { isEndpointReachable } from "../mcp/reachability.js"
import { ARC_MCP_STABLE_PORT, isStableMcpUrl } from "../mcp/endpoint.js"
import { installUserMcpConfig } from "../mcp/install.js"
import { resolveArcDb } from "../db/paths.js"

const USAGE = `arc-mcp — print or install arc's MCP client config for an agent CLI

usage:
  arc-mcp [claude|cursor|codex] [--write] [--json]

flags:
  [provider]                claude|cursor|codex; omitted prints every provider
      --write               write/merge the arc server into the provider's config
                            (claude → ./.mcp.json, cursor → ./.cursor/mcp.json,
                            codex → ~/.codex/config.toml). Target launch also
                            installs config automatically.
      --json                print the resolved endpoint + per-provider configs as JSON

The arc app publishes its live MCP endpoint to arc-mcp.json beside the profile DB
on launch; this reads it and turns it into ready-to-use client config.`

interface Parsed {
  readonly positionals: Array<string>
  readonly json: boolean
  readonly write: boolean
  readonly help: boolean
}

const parseArgs = (argv: ReadonlyArray<string>): Parsed => {
  const out = {
    positionals: [] as Array<string>,
    json: false,
    write: false,
    help: false,
  }
  for (const arg of argv) {
    switch (arg) {
      case "--json":
        out.json = true
        break
      case "--write":
        out.write = true
        break
      case "-h":
      case "--help":
      case "help":
        out.help = true
        break
      default:
        if (arg.startsWith("-")) fail(`unknown argument: ${arg}`)
        out.positionals.push(arg)
    }
  }
  return out
}

const stringProp = (value: unknown, prop: string): string | undefined => {
  if (!Predicate.hasProperty(value, prop)) return undefined
  const field = value[prop]
  return typeof field === "string" ? field : undefined
}

function fail(message: string): never {
  process.stderr.write(`arc-mcp: ${message}\n`)
  process.exit(2)
}

interface McpEndpoint {
  readonly url: string
  readonly path?: string
  readonly pid?: number
  readonly startedAt?: string
}

/** Read the discovery file the running app published next to its profile DB.
 * Absent/garbled means the app isn't up (or is on another profile) — fail with
 * the path so the fix is obvious. */
const readMcpEndpoint = (dbPath: string): McpEndpoint => {
  const file = path.join(path.dirname(dbPath), "arc-mcp.json")
  let raw: string
  try {
    raw = fs.readFileSync(file, "utf8")
  } catch {
    fail(
      `MCP discovery file not found at ${file}. Start the arc app (it publishes the endpoint on launch), then re-run.`,
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    fail(`MCP discovery file at ${file} is not valid JSON`)
  }
  const url = stringProp(parsed, "url")
  if (!url) fail(`MCP discovery file at ${file} has no "url"`)
  return {
    url,
    path: stringProp(parsed, "path"),
    pid: typeof (parsed as { pid?: unknown }).pid === "number" ? (parsed as { pid: number }).pid : undefined,
    startedAt: stringProp(parsed, "startedAt"),
  }
}

/** Merge `arc` into a provider's JSON MCP config without disturbing other
 * servers/keys; create the file (and parent dir) if absent. */
const writeJsonMcpConfig = (file: string, provider: McpProvider): void => {
  let root: Record<string, unknown> = {}
  if (fs.existsSync(file)) {
    try {
      const existing = JSON.parse(fs.readFileSync(file, "utf8"))
      if (existing && typeof existing === "object") root = existing as Record<string, unknown>
    } catch {
      fail(`${file} exists but is not valid JSON; refusing to overwrite — fix or remove it first`)
    }
  }
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(mergeArcServer(root, provider), null, 2)}\n`)
}

const runMcpConfig = async (parsed: Parsed, dbPath: string): Promise<void> => {
  const endpoint = readMcpEndpoint(dbPath)
  // The discovery file can outlive the process that wrote it (an old app exited,
  // or the stable port fell to another instance), leaving a URL that points at a
  // dead port — the exact failure that bit Codex. Verify the endpoint actually
  // accepts a connection before we emit it as usable client config, so a stale
  // discovery file fails loudly here instead of silently producing a broken
  // config the client only chokes on at startup (work_01ktx78crkfqbskfxqf77jgkjh).
  const discoveryFile = path.join(path.dirname(dbPath), "arc-mcp.json")
  const reachable = await isEndpointReachable(endpoint.url)
  if (!reachable) {
    fail(
      `arc MCP endpoint ${endpoint.url} (from ${discoveryFile}) is not reachable — nothing is listening there. ` +
        `The arc app may not be running, or it could not bind the stable MCP port. Start/restart the arc app, then re-run.`,
    )
  }
  // Reachable now ≠ stable across restarts. If the app bound an ephemeral/non-stable
  // port (ARC_MCP_PORT=0 / ARC_MCP_ALLOW_EPHEMERAL=1), this URL is live during
  // generation but its port won't persist. The rendered config always targets the
  // stable port (by design, so installed clients survive a restart), so emitting it
  // against an ephemeral run would just point clients at a port nothing is on —
  // refuse, and say how to get a stable endpoint.
  if (!isStableMcpUrl(endpoint.url)) {
    fail(
      `arc MCP endpoint ${endpoint.url} (from ${discoveryFile}) is reachable but not on the stable port ` +
        `${ARC_MCP_STABLE_PORT} — it looks ephemeral and won't survive an app restart, and arc-mcp only emits ` +
        `stable-port config. Restart the arc app on the stable port (unset ARC_MCP_PORT / ARC_MCP_ALLOW_EPHEMERAL), ` +
        `then re-run.`,
    )
  }
  const cwd = process.cwd()
  const home = os.homedir()
  const requested = parsed.positionals[0]?.toLowerCase()
  if (requested !== undefined && !isMcpProvider(requested)) {
    fail(`provider must be ${MCP_PROVIDERS.join("|")}, got: ${requested}`)
  }
  const providers: ReadonlyArray<McpProvider> = requested ? [requested] : MCP_PROVIDERS

  if (parsed.json) {
    const configs = Object.fromEntries(
      providers.map((p) => {
        const cfg = providerClientConfig(p, cwd, home)
        return [p, { file: cfg.file, writable: cfg.writable, config: cfg.render() }]
      }),
    )
    process.stdout.write(`${JSON.stringify({ endpoint, configs }, null, 2)}\n`)
    return
  }

  if (parsed.write) {
    if (!requested) {
      fail(`--write needs a provider: arc-mcp <${MCP_PROVIDERS.join("|")}> --write`)
    }
    const cfg = providerClientConfig(requested, cwd, home)
    if (cfg.writable && (requested === "claude" || requested === "cursor")) {
      writeJsonMcpConfig(cfg.file, requested)
      process.stdout.write(`wrote arc MCP config (→ ${endpoint.url}) to ${cfg.file}\n`)
      return
    }
    if (cfg.writable && requested === "codex") {
      const result = installUserMcpConfig(requested, home)
      if (!result.installed) {
        fail(`failed to write ${cfg.file}: ${result.reason ?? "unknown error"}`)
      }
      process.stdout.write(`wrote arc MCP config (→ ${endpoint.url}) to ${cfg.file}\n`)
      return
    }
    process.stdout.write(
      `${requested} config is not writable; paste:\n\n${cfg.render()}\n`,
    )
    return
  }

  process.stdout.write(
    `arc MCP endpoint: ${endpoint.url} (claude/cursor/codex connect directly with an ARC_MCP_TOKEN bearer)\n`,
  )
  for (const provider of providers) {
    const cfg = providerClientConfig(provider, cwd, home)
    const hint = cfg.writable ? `arc-mcp ${provider} --write` : "paste manually"
    process.stdout.write(`\n# ${provider} — ${cfg.file}  (${hint})\n`)
    process.stdout.write(cfg.render())
  }
}

const main = async () => {
  const parsed = parseArgs(process.argv.slice(2))
  if (parsed.help) {
    process.stdout.write(`${USAGE}\n`)
    return
  }
  // Resolve the same profile/DB the app uses (inherited via ARC_PROFILE /
  // ARC_DB_PATH from the launching session's env) to locate the discovery file
  // beside it. Echo it to stderr under ARC_DEBUG so the profile is never a
  // mystery; stdout stays clean for callers parsing --json.
  const db = resolveArcDb()
  if (process.env["ARC_DEBUG"]) {
    process.stderr.write(`arc-mcp: profile=${db.profile} db=${db.dbPath} (source=${db.source})\n`)
  }
  await runMcpConfig(parsed, db.dbPath)
}

void main()
