import * as fs from "node:fs"
import * as path from "node:path"
import { type ArcProfile, arcWorkRuntimeDir, resolveProfile } from "../db/paths.js"
import { cursorServerEntry, providerMcpLaunchArgs } from "../mcp/client-config.js"
import { CURSOR_EVENTS, ensureArcOwnedHelper, type InstallResult } from "./install.js"

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
 * shape is unit-testable without touching disk. The plugin carries the arc MCP
 * server ONLY: cursor-agent loads a `--plugin-dir` plugin's `mcp.json` but does
 * NOT fire its bundled `hooks/hooks.json` (verified against a live cursor-agent
 * v2026.06.24 — identical hooks fire from `<cwd>/.cursor/hooks.json` but never
 * from the plugin). The lifecycle hooks therefore live in `.cursor/hooks.json`
 * (see {@link buildCursorHooksJson} / {@link installCursorHooks}).
 */
export const buildCursorPluginFiles = (
  profile: ArcProfile,
  bearerToken?: string,
): Record<string, string> => {
  const manifest = {
    name: CURSOR_PLUGIN_NAME,
    version: "0.0.1",
    description: "Connects this session to Arc Work — tracks the agent's activity and gives it Arc's work-management tools.",
    mcpServers: "mcp.json",
  }
  const mcp = { mcpServers: { arc: cursorServerEntry(profile, bearerToken) } }
  return {
    ".cursor-plugin/plugin.json": json(manifest),
    "mcp.json": json(mcp),
  }
}

/**
 * The `.cursor/hooks.json` body: cursor's documented hooks format (`version: 1`
 * + an event→commands map). This is the file cursor-agent actually reads and
 * fires (project-level, in the workspace cwd) — the plugin's hooks are ignored.
 * Each event runs the Arc-owned helper, which relays cursor's hook payload
 * (carrying `session_id` + `transcript_path`) over `ARC_HOOK_SOCK` so Arc can
 * bind the native session and ingest the transcript.
 */
export const buildCursorHooksJson = (helperPath: string): string =>
  json({
    version: 1,
    hooks: Object.fromEntries(
      CURSOR_EVENTS.map((event) => [event, [{ command: hookCommand(helperPath, event) }]]),
    ),
  })

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
    ensureArcOwnedHelper(env)
    const profile = resolveProfile(env)
    for (const [rel, content] of Object.entries(buildCursorPluginFiles(profile, opts.bearerToken))) {
      const abs = path.join(dir, rel)
      fs.mkdirSync(path.dirname(abs), { recursive: true })
      fs.writeFileSync(abs, content)
    }
    return { installed: true, dir }
  } catch (e) {
    return { installed: false, dir, reason: e instanceof Error ? e.message : String(e) }
  }
}

/**
 * Write `<cwd>/.cursor/hooks.json` so cursor-agent fires Arc's lifecycle hooks
 * (the plugin's bundled hooks are ignored — see {@link buildCursorPluginFiles}).
 * This lands a file in the workspace, unlike the home/repo-clean plugin, but
 * it's a no-op without `ARC_HOOK_SOCK` (same contract as the git post-commit
 * hook) and matches how Arc already writes `.claude`/`.codex` hook config.
 * Best-effort: a failure only means native binding/ingest is unavailable.
 */
export const installCursorHooks = (
  cwd: string,
  env: NodeJS.ProcessEnv = process.env,
): InstallResult => {
  try {
    const helperPath = ensureArcOwnedHelper(env)
    const file = path.join(cwd, ".cursor", "hooks.json")
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, buildCursorHooksJson(helperPath))
    return { installed: true }
  } catch (e) {
    return { installed: false, reason: e instanceof Error ? e.message : String(e) }
  }
}

/** Launch argv to load the plugin and auto-approve its MCP server. */
export const cursorPluginLaunchArgs = (dir: string, profile: ArcProfile): ReadonlyArray<string> => [
  "--plugin-dir",
  dir,
  ...providerMcpLaunchArgs("cursor", profile),
]
