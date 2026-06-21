import { createServer } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import {
  ARC_MCP_DEV_PORT,
  ARC_MCP_STABLE_PORT,
  arcMcpPort,
  arcMcpUrl,
  chooseMcpPort,
  defaultArcMcpUrl,
  isPersistentMcpUrl,
} from "../src/main/mcp/endpoint.js"
import { isEndpointReachable } from "../src/main/mcp/reachability.js"

/**
 * Units behind the app-owned HTTP MCP endpoint:
 *  - `chooseMcpPort` must default to the profile's persistent port and *never*
 *    silently fall back to ephemeral when it's busy — only on an explicit opt-in.
 *  - The persistent port is per-profile (stable→7793, dev→7794) so the two apps
 *    never fight over one endpoint.
 *  - `isEndpointReachable` must tell a live endpoint from a dead one, so
 *    `arc-mcp` can refuse to emit a stale URL as usable config.
 *
 * `chooseMcpPort` takes the resolved persistent port as an argument, so these
 * cases stay hermetic regardless of the ambient ARC_PROFILE.
 */

const PORT = ARC_MCP_STABLE_PORT

describe("chooseMcpPort — persistent-port by default, no silent ephemeral fallback", () => {
  it("binds the persistent port when it is free and nothing overrides", () => {
    expect(chooseMcpPort({}, PORT, true)).toEqual({
      _tag: "Bind",
      port: PORT,
      ephemeral: false,
    })
  })

  it("skips (loud, no fallback) when the persistent port is busy and ephemeral isn't opted into", () => {
    const decision = chooseMcpPort({}, PORT, false)
    expect(decision._tag).toBe("Skip")
    if (decision._tag === "Skip") {
      expect(decision.reason).toContain(String(PORT))
      expect(decision.reason).toContain("ARC_MCP_ALLOW_EPHEMERAL")
    }
  })

  it("falls back to an ephemeral port only when ARC_MCP_ALLOW_EPHEMERAL=1", () => {
    expect(chooseMcpPort({ allowEphemeral: "1" }, PORT, false)).toEqual({
      _tag: "Bind",
      port: 0,
      ephemeral: true,
    })
    // Any other value is not an opt-in.
    expect(chooseMcpPort({ allowEphemeral: "true" }, PORT, false)._tag).toBe("Skip")
  })

  it("honours an explicit ARC_MCP_PORT even when the persistent port is busy", () => {
    expect(chooseMcpPort({ port: "9123" }, PORT, false)).toEqual({
      _tag: "Bind",
      port: 9123,
      ephemeral: false,
    })
    // An explicit override wins over a free persistent port too.
    expect(chooseMcpPort({ port: "9123" }, PORT, true)).toEqual({
      _tag: "Bind",
      port: 9123,
      ephemeral: false,
    })
  })

  it("treats ARC_MCP_PORT=0 as an explicit ephemeral request", () => {
    expect(chooseMcpPort({ port: "0" }, PORT, true)).toEqual({ _tag: "Bind", port: 0, ephemeral: true })
  })

  it("ignores a non-numeric ARC_MCP_PORT and uses the persistent-port rules", () => {
    expect(chooseMcpPort({ port: "nope" }, PORT, true)).toEqual({
      _tag: "Bind",
      port: PORT,
      ephemeral: false,
    })
    expect(chooseMcpPort({ port: "nope" }, PORT, false)._tag).toBe("Skip")
  })

  it("binds whichever profile's port the caller resolved", () => {
    expect(chooseMcpPort({}, ARC_MCP_DEV_PORT, true)).toEqual({
      _tag: "Bind",
      port: ARC_MCP_DEV_PORT,
      ephemeral: false,
    })
  })
})

describe("arcMcpPort / defaultArcMcpUrl — per-profile so stable and dev never collide", () => {
  it("maps each profile to its own persistent port", () => {
    expect(arcMcpPort("stable")).toBe(ARC_MCP_STABLE_PORT)
    expect(arcMcpPort("dev")).toBe(ARC_MCP_DEV_PORT)
    expect(ARC_MCP_STABLE_PORT).not.toBe(ARC_MCP_DEV_PORT)
  })

  it("renders the persistent loopback URL for the given profile", () => {
    expect(defaultArcMcpUrl("stable")).toBe(arcMcpUrl(ARC_MCP_STABLE_PORT))
    expect(defaultArcMcpUrl("dev")).toBe(arcMcpUrl(ARC_MCP_DEV_PORT))
    expect(arcMcpUrl(0)).toBe("http://127.0.0.1:0/mcp")
  })
})

describe("isPersistentMcpUrl — only the profile's persistent port is safe to bake into installed config", () => {
  it("accepts the persistent-port URL for the given profile", () => {
    expect(isPersistentMcpUrl(arcMcpUrl(ARC_MCP_STABLE_PORT), "stable")).toBe(true)
    expect(isPersistentMcpUrl(arcMcpUrl(ARC_MCP_DEV_PORT), "dev")).toBe(true)
  })

  it("rejects the other profile's port (right app, wrong profile's endpoint)", () => {
    expect(isPersistentMcpUrl(arcMcpUrl(ARC_MCP_DEV_PORT), "stable")).toBe(false)
    expect(isPersistentMcpUrl(arcMcpUrl(ARC_MCP_STABLE_PORT), "dev")).toBe(false)
  })

  it("rejects an ephemeral/non-persistent port (reachable now, gone after restart)", () => {
    expect(isPersistentMcpUrl(arcMcpUrl(56386), "stable")).toBe(false)
    expect(isPersistentMcpUrl(arcMcpUrl(9000), "stable")).toBe(false)
  })

  it("rejects a malformed url", () => {
    expect(isPersistentMcpUrl("not a url", "stable")).toBe(false)
  })
})

describe("isEndpointReachable — live vs dead endpoint", () => {
  const servers: Array<ReturnType<typeof createServer>> = []

  afterAll(async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    )
  })

  // Reject on bind error (e.g. a sandbox that denies loopback bind with EPERM)
  // rather than leaving the promise pending until the test times out — a clear
  // failure beats a 30s hang with an unhandled error.
  const listen = (): Promise<number> =>
    new Promise((resolve, reject) => {
      const server = createServer()
      servers.push(server)
      server.once("error", reject)
      server.listen(0, "127.0.0.1", () => {
        const addr = server.address()
        resolve(typeof addr === "object" && addr ? addr.port : 0)
      })
    })

  it("is true for a port that is accepting connections", async () => {
    const port = await listen()
    expect(await isEndpointReachable(arcMcpUrl(port))).toBe(true)
  })

  it("is false for a port nothing is listening on (stale discovery URL)", async () => {
    // Bind an ephemeral port, then close it so the number is almost certainly dead.
    const port = await listen()
    const server = servers.pop()!
    await new Promise<void>((resolve) => server.close(() => resolve()))
    expect(await isEndpointReachable(arcMcpUrl(port), 250)).toBe(false)
  })

  it("is false for a malformed url", async () => {
    expect(await isEndpointReachable("not a url")).toBe(false)
  })
})
