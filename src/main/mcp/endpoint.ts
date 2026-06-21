/**
 * **Arc MCP endpoint constants + the pure port-selection decision.** Split out so
 * both the server (which binds the port) and the CLI/config generation (which
 * renders the URL into client config) agree on one persistent endpoint without
 * importing the main-process server module.
 *
 * The endpoint is *persistent by design*: a fixed loopback port is what lets an
 * installed MCP client config (`arc-mcp`) survive an app restart
 * without a hand-edit — the URL stays identical across runs. Silent fallback to
 * an ephemeral port is the thing we refuse here, because installed clients load
 * config once at startup and never chase a changed discovery file
 * (`work_01ktx78crkfqbskfxqf77jgkjh`). Fallback is allowed only when explicitly
 * requested.
 *
 * The port is **per-profile**: stable and dev bind *different* loopback ports so
 * they never fight over one, and a session launched under one profile can never
 * have its MCP writes silently routed to the other profile's DB. Both apps
 * publish their own `arc-mcp.json` beside their own profile DB (see
 * db/paths.ts), so a client that reads the right discovery file — or is launched
 * by the right app — connects to the right profile.
 */
import type { ArcProfile } from "../db/paths.js"

/** The loopback port the **stable** profile's MCP server binds by default.
 * Arbitrary value in the IANA dynamic range, unlikely to collide. */
export const ARC_MCP_STABLE_PORT = 7793

/** The loopback port the **dev** profile's MCP server binds by default. One above
 * the stable port so `pnpm dev` and the installed app can run together without
 * either stealing the other's endpoint. */
export const ARC_MCP_DEV_PORT = 7794

/** The persistent loopback port a given profile binds. This is what that
 * profile's installed client configs point at and what survives a restart.
 * Override at runtime with `ARC_MCP_PORT`; opt into ephemeral with
 * `ARC_MCP_PORT=0` or `ARC_MCP_ALLOW_EPHEMERAL=1`. */
export const arcMcpPort = (profile: ArcProfile): number =>
  profile === "dev" ? ARC_MCP_DEV_PORT : ARC_MCP_STABLE_PORT

/** POST endpoint path; the discovery file records the full `http://127.0.0.1:<port>/mcp` URL. */
export const ARC_MCP_PATH = "/mcp"

/** The MCP URL for a given bound port on loopback. */
export const arcMcpUrl = (port: number): string => `http://127.0.0.1:${port}${ARC_MCP_PATH}`

/** The persistent MCP URL installed client config should point at, for the given
 * profile. A dev-launched config gets `:7794`, a stable one `:7793`, so the
 * launched agent writes back to the same profile's DB. Callers resolve the
 * profile once (at the launch site / CLI entry) and pass it in, so this never
 * depends on ambient `process.env`. */
export const defaultArcMcpUrl = (profile: ArcProfile): string => arcMcpUrl(arcMcpPort(profile))

/** Is this URL on the given profile's *persistent* port — i.e. safe to bake into
 * an installed client config that must survive an app restart? A
 * reachable-but-ephemeral URL (the app was started with
 * `ARC_MCP_PORT=0`/`ARC_MCP_ALLOW_EPHEMERAL=1`) is live *now* but its port won't
 * persist across restarts, so writing it reintroduces the stale-config failure
 * this item set out to remove. `mcp-config` refuses such URLs unless explicitly
 * told to. Returns false for a malformed URL. */
export const isPersistentMcpUrl = (url: string, profile: ArcProfile): boolean => {
  try {
    return Number.parseInt(new URL(url).port, 10) === arcMcpPort(profile)
  } catch {
    return false
  }
}

/** Outcome of resolving which port the MCP server should bind. `Bind` carries the
 * concrete port (`0` = OS-chosen ephemeral); `Skip` means we deliberately do not
 * start a second server (the profile's persistent port is taken and ephemeral
 * wasn't opted into), carrying the loud diagnostic to log instead of silently
 * degrading. */
export type McpPortDecision =
  | { readonly _tag: "Bind"; readonly port: number; readonly ephemeral: boolean }
  | { readonly _tag: "Skip"; readonly reason: string }

export interface McpPortEnv {
  /** `ARC_MCP_PORT` — explicit port override; honoured even if busy (`0` = ephemeral). */
  readonly port?: string | undefined
  /** `ARC_MCP_ALLOW_EPHEMERAL` — set to `"1"` to permit ephemeral fallback when the stable port is busy. */
  readonly allowEphemeral?: string | undefined
}

/**
 * Decide the bind port from the environment and a probe of the profile's
 * persistent port. Pure (no IO) so it is unit-testable; the caller supplies the
 * profile's `persistentPort` and whether it is free.
 *
 * Precedence:
 *  1. An explicit `ARC_MCP_PORT` (a non-negative integer) wins — the user's call,
 *     honoured even if busy; `0` means an OS-chosen ephemeral port.
 *  2. Otherwise prefer the profile's persistent port when it is free.
 *  3. When that port is busy, fall back to ephemeral *only* if
 *     `ARC_MCP_ALLOW_EPHEMERAL=1`; otherwise `Skip` — refuse to silently bind an
 *     ephemeral port that would leave installed configs pointed at a dead URL.
 *     With per-profile ports this collision means another instance *of the same
 *     profile* is already serving, not the other profile.
 */
export const chooseMcpPort = (
  env: McpPortEnv,
  persistentPort: number,
  persistentPortFree: boolean,
): McpPortDecision => {
  const raw = env.port?.trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isInteger(n) && n >= 0) return { _tag: "Bind", port: n, ephemeral: n === 0 }
  }
  if (persistentPortFree) return { _tag: "Bind", port: persistentPort, ephemeral: false }
  if (env.allowEphemeral?.trim() === "1") {
    return { _tag: "Bind", port: 0, ephemeral: true }
  }
  return {
    _tag: "Skip",
    reason:
      `arc MCP: persistent port ${persistentPort} is already in use — likely another arc instance on this ` +
      `profile is already serving MCP there. Not starting a second MCP server (refusing to silently bind an ` +
      `ephemeral port, which would leave installed client configs pointed at a dead URL). To override, set ` +
      `ARC_MCP_PORT to a specific port, or ARC_MCP_ALLOW_EPHEMERAL=1 to permit an ephemeral port.`,
  }
}
