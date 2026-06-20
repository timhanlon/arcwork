import { describe, expect, it } from "vitest"
import { CURSOR_EVENTS } from "../src/main/hooks/install.js"
import { buildCursorPluginFiles, cursorPluginLaunchArgs } from "../src/main/hooks/cursor-plugin.js"

// Cursor integrates via an Arc-owned plugin dir loaded with `--plugin-dir`, not
// repo/home config. The plugin bundles BOTH the lifecycle hooks and the arc MCP
// server, so one dir declares everything and nothing lands in the workspace.

const HELPER = "/Users/dev/.arcwork/dev/runtime/arc-hook-signal.mjs"
const files = buildCursorPluginFiles(HELPER)
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

  it("declares the arc HTTP+bearer MCP server (cursor's ${env:VAR} form)", () => {
    expect(parse("mcp.json")["mcpServers"]).toEqual({
      arc: { url: "http://127.0.0.1:7793/mcp", headers: { Authorization: "Bearer ${env:ARC_MCP_TOKEN}" } },
    })
  })

  it("wires every cursor hook event to the Arc-owned helper", () => {
    const hooks = parse("hooks/hooks.json")["hooks"] as Record<string, Array<{ command: string }>>
    expect(Object.keys(hooks).sort()).toEqual([...CURSOR_EVENTS].sort())
    // each event invokes `node "<helper>" cursor <event>` — quoted, path-correct
    for (const event of CURSOR_EVENTS) {
      expect(hooks[event]).toEqual([{ command: `node ${JSON.stringify(HELPER)} cursor ${event}` }])
    }
  })
})

describe("cursorPluginLaunchArgs", () => {
  it("loads the plugin dir and auto-approves its MCP server", () => {
    expect(cursorPluginLaunchArgs("/arc/arc-work")).toEqual([
      "--plugin-dir",
      "/arc/arc-work",
      "--approve-mcps",
    ])
  })
})
