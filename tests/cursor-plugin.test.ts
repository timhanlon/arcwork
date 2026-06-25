import { describe, expect, it } from "vitest"
import { CURSOR_EVENTS } from "../src/main/hooks/install.js"
import { buildCursorHooksJson, buildCursorPluginFiles, cursorPluginLaunchArgs } from "../src/main/hooks/cursor-plugin.js"

// Cursor integrates via an Arc-owned plugin dir loaded with `--plugin-dir` for
// the MCP server, plus a `.cursor/hooks.json` in the workspace for the lifecycle
// hooks: cursor-agent loads a plugin's mcp.json but ignores its bundled hooks
// (verified live), so the two halves live in different files.

const HELPER = "/Users/dev/.arcwork/dev/runtime/arc-hook-signal.mjs"
// Built for the dev profile, so the MCP server URL targets dev's port (:7794).
const files = buildCursorPluginFiles("dev")
const parse = (rel: string) => JSON.parse(files[rel]!) as Record<string, unknown>

describe("buildCursorPluginFiles", () => {
  it("emits only the MCP plugin files (no bundled hooks — cursor-agent ignores them)", () => {
    expect(Object.keys(files).sort()).toEqual([".cursor-plugin/plugin.json", "mcp.json"])
  })

  it("manifest names the plugin 'arc-work' (Cursor shows this in /plugins) and points at its MCP only", () => {
    const m = parse(".cursor-plugin/plugin.json")
    expect(m["name"]).toBe("arc-work")
    expect(m["hooks"]).toBeUndefined()
    expect(m["mcpServers"]).toBe("mcp.json")
  })

  it("declares the arc HTTP+bearer MCP server on the dev profile's port (env form when no session bearer)", () => {
    expect(parse("mcp.json")["mcpServers"]).toEqual({
      arc: { url: "http://127.0.0.1:7794/mcp", headers: { Authorization: "Bearer ${env:ARC_MCP_TOKEN}" } },
    })
  })

  it("bakes a session bearer in literally when given (Cursor won't interpolate ${env:…} in headers)", () => {
    const withToken = buildCursorPluginFiles("dev", "target_abc:chat_xyz")
    expect((JSON.parse(withToken["mcp.json"]!) as Record<string, unknown>)["mcpServers"]).toEqual({
      arc: { url: "http://127.0.0.1:7794/mcp", headers: { Authorization: "Bearer target_abc:chat_xyz" } },
    })
  })
})

describe("buildCursorHooksJson", () => {
  const root = JSON.parse(buildCursorHooksJson(HELPER)) as Record<string, unknown>

  it("uses cursor's documented hooks format (version 1)", () => {
    expect(root["version"]).toBe(1)
  })

  it("wires every cursor hook event to the Arc-owned helper", () => {
    const hooks = root["hooks"] as Record<string, Array<{ command: string }>>
    expect(Object.keys(hooks).sort()).toEqual([...CURSOR_EVENTS].sort())
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
