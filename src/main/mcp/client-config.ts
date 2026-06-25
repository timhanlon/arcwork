import * as path from "node:path"
import type { ArcProfile } from "../db/paths.js"
import { defaultArcMcpUrl } from "./endpoint.js"

/**
 * **Per-provider MCP client config** — turn the Arc MCP server's published
 * endpoint (the `arc-mcp.json` discovery file) into the config each target CLI
 * needs to connect, so wiring an implementer to the chief-of-staff loop is a
 * command (`arc-mcp`) rather than a hand-edit
 * (`work_01ktwe363ae8gtf0065zecgm78`).
 *
 * claude/cursor/codex connect **straight to the shared HTTP endpoint** and carry
 * per-session provenance in an `Authorization: Bearer <sessionId:chatId>` header
 * sourced from the launched session's `ARC_MCP_TOKEN` env var — claude via
 * `.mcp.json` `${VAR}` expansion, cursor via `mcp.json` `${env:VAR}` expansion,
 * codex via its TOML `bearer_token_env_var`. This generalized the Codex bearer
 * path (`work_01kv78wjgbfan88t7t249ezhj9`) to the JSON providers and retired the
 * per-session stdio proxy (`work_01kv79rzmhfan89d0sh7zcc0wj`).
 *
 * This module is pure (no IO, no `process`): it maps a provider to the config
 * entry and the file it belongs in. The endpoint URL is per-profile (dev→:7794,
 * stable→:7793), so the resolved `ArcProfile` is threaded in by the caller rather
 * than read from ambient env — keeping rendering deterministic and the shapes
 * unit-testable without executing the CLI's `main`.
 */

export const MCP_PROVIDERS = ["claude", "cursor", "codex"] as const
export type McpProvider = (typeof MCP_PROVIDERS)[number]

export const isMcpProvider = (value: string): value is McpProvider =>
  (MCP_PROVIDERS as ReadonlyArray<string>).includes(value)

/** Bearer header referencing `ARC_MCP_TOKEN` in each provider's config-interpolation
 * syntax — claude expands `${VAR}`, cursor expands `${env:VAR}`. Plain strings (not
 * template literals) so the `${…}` reaches the written config file verbatim and the
 * CLI expands it from the launched session's env at connect time. */
const bearerAuthHeaders = (provider: McpProvider): Record<string, string> => ({
  Authorization: provider === "cursor" ? "Bearer ${env:ARC_MCP_TOKEN}" : "Bearer ${ARC_MCP_TOKEN}",
})

/** The MCP client entry for the `arc` server under one provider. claude/cursor use a
 * direct HTTP transport carrying the `ARC_MCP_TOKEN` bearer header (claude needs an
 * explicit `type: "http"`; cursor infers it from `url`). The URL targets the given
 * profile's persistent port. */
export const providerServerEntry = (
  provider: McpProvider,
  profile: ArcProfile,
): Record<string, unknown> => {
  const http = { url: defaultArcMcpUrl(profile), headers: bearerAuthHeaders(provider) }
  return provider === "claude" ? { type: "http", ...http } : http
}

/**
 * Cursor's `arc` server entry. Cursor does **not** interpolate `${env:…}` inside
 * MCP request headers, so the `${env:ARC_MCP_TOKEN}` form ships the literal
 * placeholder as the bearer — the server then parses `${env` / `ARC_MCP_TOKEN}`
 * as the session/chat ids and poisons every write's provenance. When Arc owns a
 * per-session plugin dir it knows the `targetSessionId:chatId` at write time and
 * bakes it in literally (`bearerToken`); the shared/preview path (no token) keeps
 * the env form so one file can still serve a manually-configured session.
 */
export const cursorServerEntry = (profile: ArcProfile, bearerToken?: string): Record<string, unknown> =>
  bearerToken === undefined
    ? providerServerEntry("cursor", profile)
    : { url: defaultArcMcpUrl(profile), headers: { Authorization: `Bearer ${bearerToken}` } }

/**
 * Extra argv that declares the `arc` MCP server to a launched CLI *without*
 * writing a config file into the repo — the repo-clean lever for the auto
 * launch path (Arc owns the spawn argv at `TargetSessionManager`):
 *
 *   • claude — `--mcp-config '<json>'` accepts the server inline as a JSON
 *     string (no `--strict-mcp-config`, so the user's own MCP servers still load).
 *   • codex  — `-c mcp_servers.arc.*=<toml>` overrides nested config inline,
 *     touching neither the repo nor the user's `~/.codex/config.toml`.
 *   • cursor — has no inline lever; the server lives in `~/.cursor/mcp.json`
 *     (see {@link cursorHomeMcpFile}), so launch only needs `--approve-mcps`
 *     to skip the approval prompt.
 *
 * Passed through node-pty's argv array (no shell), so the JSON/TOML values reach
 * the CLI verbatim — no quoting hazard. `${ARC_MCP_TOKEN}` / `bearer_token_env_var`
 * resolve from the session's injected env at connect time, exactly as the file
 * forms do.
 */
export const providerMcpLaunchArgs = (
  provider: McpProvider,
  profile: ArcProfile,
): ReadonlyArray<string> => {
  switch (provider) {
    case "claude":
      return [
        "--mcp-config",
        JSON.stringify({ mcpServers: { arc: providerServerEntry("claude", profile) } }),
      ]
    case "codex":
      return [
        "-c",
        `mcp_servers.arc.url="${defaultArcMcpUrl(profile)}"`,
        "-c",
        `mcp_servers.arc.bearer_token_env_var="ARC_MCP_TOKEN"`,
      ]
    case "cursor":
      // cursor declares the server in its plugin's mcp.json (loaded via
      // --plugin-dir; see cursor-plugin.ts). Arc launches cursor-agent with no
      // human at its PTY to clear prompts, so `--approve-mcps` alone leaves it
      // stalled on the per-tool-call approval. `--force` (run unless explicitly
      // denied) clears that. NOT `--trust` — cursor-agent rejects it outside
      // --print/headless mode ("--trust can only be used with --print"), which
      // is why the interactive target then exits 1.
      return ["--approve-mcps", "--force"]
  }
}

export interface ProviderClientConfig {
  /** Absolute path to the file this provider reads its MCP config from. */
  readonly file: string
  /** Whether `mcp-config --write` will edit the file (JSON providers) or only
   * print a snippet to paste (user-scoped/non-JSON providers). */
  readonly writable: boolean
  /** The full config file contents (writable providers) or the snippet to paste
   * (others), ready to print. */
  readonly render: () => string
}

/**
 * Where and how a provider declares the `arc` MCP server. `cwd` scopes the
 * project-local JSON providers (claude/cursor); `home` scopes the user-level
 * one (codex) — both injected so the mapping stays pure and testable.
 */
export const providerClientConfig = (
  provider: McpProvider,
  cwd: string,
  home: string,
  profile: ArcProfile,
): ProviderClientConfig => {
  const jsonDoc = () =>
    `${JSON.stringify({ mcpServers: { arc: providerServerEntry(provider, profile) } }, null, 2)}\n`
  switch (provider) {
    case "claude":
      return { file: path.join(cwd, ".mcp.json"), writable: true, render: jsonDoc }
    case "cursor":
      return { file: path.join(cwd, ".cursor", "mcp.json"), writable: true, render: jsonDoc }
    case "codex":
      return {
        file: path.join(home, ".codex", "config.toml"),
        writable: true,
        render: () =>
          `[mcp_servers.arc]\nurl = "${defaultArcMcpUrl(profile)}"\nbearer_token_env_var = "ARC_MCP_TOKEN"\n`,
      }
  }
}

/** Merge the `arc` server into an existing JSON MCP config object without
 * disturbing other servers or top-level keys. Returns a new root object. */
export const mergeArcServer = (
  root: Record<string, unknown>,
  provider: McpProvider,
  profile: ArcProfile,
): Record<string, unknown> => {
  const servers =
    root["mcpServers"] && typeof root["mcpServers"] === "object"
      ? { ...(root["mcpServers"] as Record<string, unknown>) }
      : {}
  servers["arc"] = providerServerEntry(provider, profile)
  return { ...root, mcpServers: servers }
}

/** Repo-local MCP config paths we can merge at target launch (claude/cursor). */
export const repoMcpConfigFile = (provider: McpProvider, repoRoot: string): string | undefined => {
  switch (provider) {
    case "claude":
      return path.join(repoRoot, ".mcp.json")
    case "cursor":
      return path.join(repoRoot, ".cursor", "mcp.json")
    default:
      return undefined
  }
}

/** User-scoped MCP config paths (codex) — installed at launch when possible. */
export const userMcpConfigFile = (provider: McpProvider, home: string): string | undefined => {
  switch (provider) {
    case "codex":
      return path.join(home, ".codex", "config.toml")
    default:
      return undefined
  }
}
