import * as fs from "node:fs"
import * as path from "node:path"
import { type ArcProfile, arcWorkRuntimeDir, resolveProfile } from "../db/paths.js"
import { cursorServerEntry, providerMcpLaunchArgs } from "../mcp/client-config.js"
import { CURSOR_EVENTS, ensureArcOwnedHelper } from "./install.js"

/**
 * Cursor integration as a **plugin** rather than repo/home config writes.
 *
 * `cursor-agent --plugin-dir <dir>` loads a plugin directory at launch (Arc owns
 * the argv), and a plugin bundles *both* the lifecycle hooks (`hooks/hooks.json`)
 * and the arc MCP server (`mcp.json`, auto-detected at the plugin root). So one
 * Arc-owned plugin dir, outside any repo and outside `~/.cursor`, declares
 * everything — nothing is written into the workspace, and unlike the home-global
 * `~/.cursor/mcp.json` fallback this leaves no durable user-config to clean up.
 *
 * Cursor has no inline config flag (no `--mcp-config`, no `CURSOR_HOME`), so
 * `--plugin-dir` is the only repo-clean *and* home-clean lever it offers. The
 * plugin lives next to the hook helper under `~/.arcwork/<profile>/runtime/`.
 *
 * PROTOTYPE: the manifest/file shapes are verified against the Cursor plugin
 * reference, but whether `--plugin-dir` hooks/MCP load without an interactive
 * approval prompt is not yet confirmed against a live `cursor-agent` session.
 */

/** Plugin name + directory basename. Cursor's `/plugins` shows the directory
 * name, so this must be the product slug, not an implementation label. */
export const CURSOR_PLUGIN_NAME = "arc-work"

/**
 * The plugin dir passed to `--plugin-dir`. A `scopeId` (the target session id)
 * roots it under a per-session subdir so concurrent Cursor agents don't clobber
 * each other's `mcp.json` — each carries its own session-specific bearer. The
 * `arc-work` basename is preserved either way, since Cursor's `/plugins` shows
 * the directory name. No scope → the shared profile-level dir (CLI preview).
 */
export const cursorPluginDir = (
  opts: { env?: NodeJS.ProcessEnv; scopeId?: string } = {},
): string => {
  const base = arcWorkRuntimeDir(resolveProfile(opts.env ?? process.env))
  return opts.scopeId
    ? path.join(base, "sessions", opts.scopeId, CURSOR_PLUGIN_NAME)
    : path.join(base, CURSOR_PLUGIN_NAME)
}

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`

/** `node "<helper>" cursor <event>` — same invocation the repo-local hooks used,
 * just relocated into the plugin and pointed at the Arc-owned helper path. */
const hookCommand = (helperPath: string, event: string): string =>
  `node ${JSON.stringify(helperPath)} cursor ${event}`

/**
 * The plugin's files as a `relativePath → contents` map (pure — no IO), so the
 * shape is unit-testable without touching disk. `plugin.json` is explicit about
 * the `hooks`/`mcpServers` paths even though Cursor auto-detects both, so a
 * future layout change can't silently drop a component.
 */
export const buildCursorPluginFiles = (
  helperPath: string,
  profile: ArcProfile,
  bearerToken?: string,
): Record<string, string> => {
  const manifest = {
    name: CURSOR_PLUGIN_NAME,
    version: "0.0.1",
    description: "Connects this session to Arc Work — tracks the agent's activity and gives it Arc's work-management tools.",
    hooks: "hooks/hooks.json",
    mcpServers: "mcp.json",
  }
  const hooks = {
    hooks: Object.fromEntries(
      CURSOR_EVENTS.map((event) => [
        event,
        [{ command: hookCommand(helperPath, event) }],
      ]),
    ),
  }
  const mcp = { mcpServers: { arc: cursorServerEntry(profile, bearerToken) } }
  return {
    ".cursor-plugin/plugin.json": json(manifest),
    "hooks/hooks.json": json(hooks),
    "mcp.json": json(mcp),
  }
}

export interface CursorPluginResult {
  readonly installed: boolean
  readonly dir: string
  readonly reason?: string
}

/** Ensure the helper exists and (re)write the Arc-owned cursor plugin dir.
 * Best-effort and idempotent — overwrites its own files, never throws. A
 * `scopeId` (target session id) gives this launch its own dir + `bearerToken`,
 * so concurrent same-provider agents each carry their own provenance. */
export const installCursorPlugin = (
  opts: { env?: NodeJS.ProcessEnv; scopeId?: string; bearerToken?: string } = {},
): CursorPluginResult => {
  const env = opts.env ?? process.env
  const dir = cursorPluginDir({ env, scopeId: opts.scopeId })
  try {
    const helperPath = ensureArcOwnedHelper(env)
    const profile = resolveProfile(env)
    for (const [rel, content] of Object.entries(buildCursorPluginFiles(helperPath, profile, opts.bearerToken))) {
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    return { installed: true, dir }
  } catch (e) {
    return { installed: false, dir, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Launch argv to load the plugin and auto-approve its MCP server. */
export const cursorPluginLaunchArgs = (dir: string, profile: ArcProfile): ReadonlyArray<string> => [
  "--plugin-dir",
  dir,
  ...providerMcpLaunchArgs("cursor", profile),
]
