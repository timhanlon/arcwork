import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import {
  cursorHomeMcpFile,
  type McpProvider,
  mergeArcServer,
  repoMcpConfigFile,
  userMcpConfigFile,
} from "./client-config.js"
import { defaultArcMcpUrl } from "./endpoint.js"

export interface InstallResult {
  readonly installed: boolean
  readonly scope: "repo" | "user" | "none"
  readonly reason?: string
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null

/** Merge the arc HTTP+bearer server (claude/cursor) into a repo-local MCP config file. */
export const installRepoMcpConfig = (
  repoRoot: string,
  provider: McpProvider,
): InstallResult => {
  const file = repoMcpConfigFile(provider, repoRoot)
  if (!file) return { installed: true, scope: "none" }

  try {
    let root: Record<string, unknown> = {}
    if (fs.existsSync(file)) {
      const existing: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (isRecord(existing)) root = existing
      else throw new Error(`existing ${file} is not a JSON object`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(mergeArcServer(root, provider), null, 2)}\n`)
    return { installed: true, scope: "repo" }
  } catch (e) {
    return {
      installed: false,
      scope: "repo",
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

const CODEX_ARC_SECTION = /\[mcp_servers\.arc\][\s\S]*?(?=\n\[|\n*$)/
const RMCP_CLIENT_FLAG = /^\s*experimental_use_rmcp_client\s*=.*$/gm

/** Replace or append the arc MCP block in a Codex config.toml. */
export const mergeCodexMcpToml = (content: string): string => {
  const block = `[mcp_servers.arc]\nurl = "${defaultArcMcpUrl()}"\nbearer_token_env_var = "ARC_MCP_TOKEN"\n`
  const stripped = content
    .replace(CODEX_ARC_SECTION, "")
    .replace(RMCP_CLIENT_FLAG, "")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()
  return stripped ? `${stripped}\n\n${block}` : `${block}`
}

/** Merge the arc HTTP+bearer server into a user-scoped MCP config (codex TOML). */
export const installUserMcpConfig = (
  provider: McpProvider,
  home: string = os.homedir(),
): InstallResult => {
  const file = userMcpConfigFile(provider, home)
  if (!file) return { installed: true, scope: "none" }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    if (provider === "codex") {
      const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : ""
      fs.writeFileSync(file, mergeCodexMcpToml(existing))
      return { installed: true, scope: "user" }
    }
    return { installed: true, scope: "none" }
  } catch (e) {
    return {
      installed: false,
      scope: "user",
      reason: e instanceof Error ? e.message : String(e),
    }
  }
}

/**
 * Merge the arc server into Cursor's home-global `~/.cursor/mcp.json`. Keyed by
 * server name (`mergeArcServer` overwrites `mcpServers.arc`), so it's idempotent
 * and leaves the user's own servers untouched — no append/prune dance needed.
 */
export const installCursorHomeMcpConfig = (home: string = os.homedir()): InstallResult => {
  const file = cursorHomeMcpFile(home)
  try {
    let root: Record<string, unknown> = {}
    if (fs.existsSync(file)) {
      const existing: unknown = JSON.parse(fs.readFileSync(file, "utf8"))
      if (isRecord(existing)) root = existing
      else throw new Error(`existing ${file} is not a JSON object`)
    }
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, `${JSON.stringify(mergeArcServer(root, "cursor"), null, 2)}\n`)
    return { installed: true, scope: "user" }
  } catch (e) {
    return { installed: false, scope: "user", reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Launch-time MCP setup for the auto path — repo-clean by construction.
 * claude/codex declare the arc server inline through argv (see
 * `providerMcpLaunchArgs`), so there is nothing to write; only cursor, which has
 * no inline lever, needs a file — and that file is its home-global config, never
 * the repo. The explicit `arc-mcp <provider> --write` CLI still writes repo/user
 * files for users who want a persistent hand-editable config.
 */
export const installMcpConfig = (provider: McpProvider): InstallResult => {
  if (provider === "cursor") return installCursorHomeMcpConfig()
  return { installed: true, scope: "none" }
}
