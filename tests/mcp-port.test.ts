import { createServer } from "node:net"
import { afterAll, describe, expect, it } from "vitest"
import {
  ARC_MCP_STABLE_PORT,
  arcMcpUrl,
  chooseMcpPort,
  defaultArcMcpUrl,
  isStableMcpUrl,
} from "../src/main/mcp/endpoint.js"
import { isEndpointReachable } from "../src/main/mcp/reachability.js"

/**
 * Two units behind "make the app-owned HTTP MCP endpoint stable for installed
 * clients" (work_01ktx78crkfqbskfxqf77jgkjh):
 *  - `chooseMcpPort` must default to the stable port and *never* silently fall
 *    back to ephemeral when it's busy — only on an explicit opt-in.
 *  - `isEndpointReachable` must tell a live endpoint from a dead one, so
 *    `arc-mcp` can refuse to emit a stale URL as usable config.
 */

describe("chooseMcpPort — stable by default, no silent ephemeral fallback", () => {
  it("binds the stable port when it is free and nothing overrides", () => {
    expect(chooseMcpPort({}, true)).toEqual({
      _tag: "Bind",
      port: ARC_MCP_STABLE_PORT,
      ephemeral: false,
    })
  })

  it("skips (loud, no fallback) when the stable port is busy and ephemeral isn't opted into", () => {
    const decision = chooseMcpPort({}, false)
    expect(decision._tag).toBe("Skip")
    if (decision._tag === "Skip") {
      expect(decision.reason).toContain(String(ARC_MCP_STABLE_PORT))
      expect(decision.reason).toContain("ARC_MCP_ALLOW_EPHEMERAL")
    }
  })

  it("falls back to an ephemeral port only when ARC_MCP_ALLOW_EPHEMERAL=1", () => {
    expect(chooseMcpPort({ allowEphemeral: "1" }, false)).toEqual({
      _tag: "Bind",
      port: 0,
      ephemeral: true,
    })
    // Any other value is not an opt-in.
    expect(chooseMcpPort({ allowEphemeral: "true" }, false)._tag).toBe("Skip")
  })

  it("honours an explicit ARC_MCP_PORT even when the stable port is busy", () => {
    expect(chooseMcpPort({ port: "9123" }, false)).toEqual({
      _tag: "Bind",
      port: 9123,
      ephemeral: false,
    })
    // An explicit override wins over a free stable port too.
    expect(chooseMcpPort({ port: "9123" }, true)).toEqual({
      _tag: "Bind",
      port: 9123,
      ephemeral: false,
    })
  })

  it("treats ARC_MCP_PORT=0 as an explicit ephemeral request", () => {
    expect(chooseMcpPort({ port: "0" }, true)).toEqual({ _tag: "Bind", port: 0, ephemeral: true })
  })

  it("ignores a non-numeric ARC_MCP_PORT and uses the stable-port rules", () => {
    expect(chooseMcpPort({ port: "nope" }, true)).toEqual({
      _tag: "Bind",
      port: ARC_MCP_STABLE_PORT,
      ephemeral: false,
    })
    expect(chooseMcpPort({ port: "nope" }, false)._tag).toBe("Skip")
  })

  it("defaultArcMcpUrl is the stable loopback URL", () => {
    expect(defaultArcMcpUrl()).toBe(`http://127.0.0.1:${ARC_MCP_STABLE_PORT}/mcp`)
    expect(arcMcpUrl(0)).toBe("http://127.0.0.1:0/mcp")
  })
})

describe("isStableMcpUrl — only the stable port is safe to bake into installed config", () => {
  it("accepts the stable-port URL", () => {
    expect(isStableMcpUrl(defaultArcMcpUrl())).toBe(true)
    expect(isStableMcpUrl(arcMcpUrl(ARC_MCP_STABLE_PORT))).toBe(true)
  })

  it("rejects an ephemeral/non-stable port (reachable now, gone after restart)", () => {
    expect(isStableMcpUrl(arcMcpUrl(56386))).toBe(false)
    expect(isStableMcpUrl(arcMcpUrl(9000))).toBe(false)
  })

  it("rejects a malformed url", () => {
    expect(isStableMcpUrl("not a url")).toBe(false)
  })
})

describe("isEndpointReachable — live vs dead endpoint", () => {
  const servers: Array<ReturnType<typeof createServer>> = []

  afterAll(async () => {
    await Promise.all(
      servers.map((s) => new Promise<void>((resolve) => s.close(() => resolve()))),
    )
  })

  const listen = (): Promise<number> =>
    new Promise((resolve) => {
      const server = createServer()
      servers.push(server)
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
