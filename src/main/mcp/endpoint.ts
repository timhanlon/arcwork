/**
 * **Arc MCP endpoint constants + the pure port-selection decision.** Split out so
 * both the server (which binds the port) and the CLI/config generation (which
 * renders the URL into client config) agree on one stable endpoint without
 * importing the main-process server module.
 *
 * The endpoint is *stable by design*: a fixed loopback port is what lets an
 * installed MCP client config (`arc-mcp`) survive an app restart
 * without a hand-edit — the URL stays identical across runs. Silent fallback to
 * an ephemeral port is the thing we refuse here, because installed clients load
 * config once at startup and never chase a changed discovery file
 * (`work_01ktx78crkfqbskfxqf77jgkjh`). Fallback is allowed only when explicitly
 * requested.
 */

/** The stable loopback port the app MCP server binds by default. Arbitrary value
 * in the IANA dynamic range, unlikely to collide; what installed client configs
 * point at. Override with `ARC_MCP_PORT`; opt into ephemeral with `ARC_MCP_PORT=0`
 * or `ARC_MCP_ALLOW_EPHEMERAL=1`. */
export const ARC_MCP_STABLE_PORT = 7793

/** POST endpoint path; the discovery file records the full `http://127.0.0.1:<port>/mcp` URL. */
export const ARC_MCP_PATH = "/mcp"

/** The MCP URL for a given bound port on loopback. */
export const arcMcpUrl = (port: number): string => `http://127.0.0.1:${port}${ARC_MCP_PATH}`

/** The stable MCP URL installed client config should point at. */
export const defaultArcMcpUrl = (): string => arcMcpUrl(ARC_MCP_STABLE_PORT)

/** Is this URL on the stable port — i.e. safe to bake into an installed client
 * config that must survive an app restart? A reachable-but-ephemeral URL (the app
 * was started with `ARC_MCP_PORT=0`/`ARC_MCP_ALLOW_EPHEMERAL=1`) is live *now* but
 * its port won't persist across restarts, so writing it reintroduces the
 * stale-config failure this item set out to remove. `mcp-config` refuses such URLs
 * unless explicitly told to. Returns false for a malformed URL. */
export const isStableMcpUrl = (url: string): boolean => {
  try {
    return Number.parseInt(new URL(url).port, 10) === ARC_MCP_STABLE_PORT
  } catch {
    return false
  }
}

/** Outcome of resolving which port the MCP server should bind. `Bind` carries the
 * concrete port (`0` = OS-chosen ephemeral); `Skip` means we deliberately do not
 * start a second server (the stable port is taken and ephemeral wasn't opted into),
 * carrying the loud diagnostic to log instead of silently degrading. */
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
 * Decide the bind port from the environment and a probe of the stable port.
 * Pure (no IO) so it is unit-testable; the caller supplies `stablePortFree`.
 *
 * Precedence:
 *  1. An explicit `ARC_MCP_PORT` (a non-negative integer) wins — the user's call,
 *     honoured even if busy; `0` means an OS-chosen ephemeral port.
 *  2. Otherwise prefer the stable port when it is free.
 *  3. When the stable port is busy, fall back to ephemeral *only* if
 *     `ARC_MCP_ALLOW_EPHEMERAL=1`; otherwise `Skip` — refuse to silently bind an
 *     ephemeral port that would leave installed configs pointed at a dead URL.
 */
export const chooseMcpPort = (env: McpPortEnv, stablePortFree: boolean): McpPortDecision => {
  const raw = env.port?.trim()
  if (raw) {
    const n = Number.parseInt(raw, 10)
    if (Number.isInteger(n) && n >= 0) return { _tag: "Bind", port: n, ephemeral: n === 0 }
  }
  if (stablePortFree) return { _tag: "Bind", port: ARC_MCP_STABLE_PORT, ephemeral: false }
  if (env.allowEphemeral?.trim() === "1") {
    return { _tag: "Bind", port: 0, ephemeral: true }
  }
  return {
    _tag: "Skip",
    reason:
      `arc MCP: stable port ${ARC_MCP_STABLE_PORT} is already in use — likely another arc instance is ` +
      `already serving MCP there. Not starting a second MCP server (refusing to silently bind an ephemeral ` +
      `port, which would leave installed client configs pointed at a dead URL). To override, set ARC_MCP_PORT ` +
      `to a specific port, or ARC_MCP_ALLOW_EPHEMERAL=1 to permit an ephemeral port.`,
  }
}
