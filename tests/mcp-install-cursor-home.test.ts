import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { installCursorHomeMcpConfig } from "../src/main/mcp/install.js"

// Cursor has no inline lever (verified: no --mcp-config flag, no CURSOR_HOME), so
// its arc server lands in the user's home-global ~/.cursor/mcp.json — never the
// repo. The merge is keyed by server name, so it must be idempotent and must not
// disturb the user's own servers.

const read = (home: string) =>
  JSON.parse(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")) as {
    mcpServers: Record<string, unknown>
  }

describe("installCursorHomeMcpConfig", () => {
  let home: string
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "arc-cursor-home-"))
  })
  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("creates ~/.cursor/mcp.json with the arc HTTP+bearer server", () => {
    const result = installCursorHomeMcpConfig(home)
    expect(result).toEqual({ installed: true, scope: "user" })
    expect(read(home).mcpServers["arc"]).toEqual({
      url: "http://127.0.0.1:7793/mcp",
      headers: { Authorization: "Bearer ${env:ARC_MCP_TOKEN}" },
    })
  })

  it("preserves the user's own servers and is idempotent", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true })
    writeFileSync(
      join(home, ".cursor", "mcp.json"),
      JSON.stringify({ mcpServers: { mine: { url: "http://localhost:1234" } } }),
    )

    installCursorHomeMcpConfig(home)
    installCursorHomeMcpConfig(home) // re-merge must not duplicate or clobber

    const servers = read(home).mcpServers
    expect(servers["mine"]).toEqual({ url: "http://localhost:1234" })
    expect(servers["arc"]).toBeDefined()
    expect(Object.keys(servers).sort()).toEqual(["arc", "mine"])
  })

  it("leaves an unparseable config untouched rather than clobbering it", () => {
    mkdirSync(join(home, ".cursor"), { recursive: true })
    writeFileSync(join(home, ".cursor", "mcp.json"), "{ not valid json")
    const result = installCursorHomeMcpConfig(home)
    expect(result.installed).toBe(false)
    expect(result.reason).toBeDefined()
    expect(readFileSync(join(home, ".cursor", "mcp.json"), "utf8")).toBe("{ not valid json")
  })
})
