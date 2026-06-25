import { describe, expect, it } from "vitest"
import { CURSOR_EVENTS } from "../src/main/hooks/install.js"
import { buildCursorPluginFiles, cursorPluginLaunchArgs } from "../src/main/hooks/cursor-plugin.js"

// Cursor integrates via an Arc-owned plugin dir loaded with `--plugin-dir`, not
// repo/home config. The plugin bundles BOTH the lifecycle hooks and the arc MCP
// server, so one dir declares everything and nothing lands in the workspace.

const HELPER = "/Users/dev/.arcwork/dev/runtime/arc-hook-signal.mjs"
// Built for the dev profile, so the MCP server URL targets dev's port (:7794).
const files = buildCursorPluginFiles(HELPER, "dev")
const parse = (rel: string) => JSON.parse(files[rel]!) as Record<string, unknown>

describe("buildCursorPluginFiles", () => {
  it("emits the three plugin files Cursor auto-detects", () => {
    expect(Object.keys(files).sort()).toEqual([".cursor-plugin/plugin.json", "hooks/hooks.json", "mcp.json"])
  })

  it("manifest names the plugin 'arc-work' (Cursor shows this in /plugins) and points at its components", () => {
    const m = parse(".cursor-plugin/plugin.json")
    expect(m["name"]).toBe("arc-work")
    expect(m["hooks"]).toBe("hooks/hooks.json")
    expect(m["mcpServers"]).toBe("mcp.json")
  })

  it("declares the arc HTTP+bearer MCP server on the dev profile's port (env form when no session bearer)", () => {
    expect(parse("mcp.json")["mcpServers"]).toEqual({
      arc: { url: "http://127.0.0.1:7794/mcp", headers: { Authorization: "Bearer ${env:ARC_MCP_TOKEN}" } },
    })
  })

  it("bakes a session bearer in literally when given (Cursor won't interpolate ${env:…} in headers)", () => {
    const withToken = buildCursorPluginFiles(HELPER, "dev", "target_abc:chat_xyz")
    expect((JSON.parse(withToken["mcp.json"]!) as Record<string, unknown>)["mcpServers"]).toEqual({
      arc: { url: "http://127.0.0.1:7794/mcp", headers: { Authorization: "Bearer target_abc:chat_xyz" } },
    })
  })

  it("wires every cursor hook event to the Arc-owned helper", () => {
    const root = parse("hooks/hooks.json")
    const hooks = root["hooks"] as Record<string, Array<{ command: string }>>
    expect(Object.keys(hooks).sort()).toEqual([...CURSOR_EVENTS].sort())
    // each event invokes `node "<helper>" cursor <event>` in the plugin hook
    // block shape Cursor-native plugins load.
    for (const event of CURSOR_EVENTS) {
      expect(hooks[event]).toEqual([{ command: `node ${JSON.stringify(HELPER)} cursor ${event}` }])
    }
  })
})

describe("cursorPluginLaunchArgs", () => {
  it("loads the plugin dir and auto-approves + force-allows its MCP server", () => {
    expect(cursorPluginLaunchArgs("/arc/arc-work", "dev")).toEqual([
      "--plugin-dir",
      "/arc/arc-work",
      "--approve-mcps",
      "--force",
    ])
  })
})
