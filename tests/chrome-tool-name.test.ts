import { describe, expect, it } from "vitest"
import { chromeToolLabel, chromeVerb, isChromeTool } from "../src/renderer/src/chat/tool-calls/chrome-tool-name.js"

// The renderer must recognise Claude-in-Chrome MCP tool calls and recover the
// verb so each browser action renders as a dedicated card. The toolkit is
// Claude-Code-only and always namespaced, so — unlike arc — we claim only the
// namespaced forms and never a bare verb. Pure string logic; see chrome-tool-name.ts.

describe("chrome tool-name parsing", () => {
  const cases = [
    { cli: "Claude", name: "mcp__claude-in-chrome__navigate" },
    { cli: "Cursor", name: "mcp_claude-in-chrome_navigate" },
  ] as const

  for (const { cli, name } of cases) {
    it(`recognises and labels the ${cli} flattening`, () => {
      expect(isChromeTool(name)).toBe(true)
      expect(chromeVerb(name)).toBe("navigate")
      expect(chromeToolLabel(name)).toBe("chrome.navigate")
    })
  }

  it("recovers verbs across the toolkit", () => {
    expect(chromeVerb("mcp__claude-in-chrome__computer")).toBe("computer")
    expect(chromeVerb("mcp__claude-in-chrome__tabs_create_mcp")).toBe("tabs_create_mcp")
  })

  it("trims the internal `_mcp` transport suffix from the header label", () => {
    expect(chromeToolLabel("mcp__claude-in-chrome__tabs_create_mcp")).toBe("chrome.tabs_create")
    expect(chromeToolLabel("mcp__claude-in-chrome__tabs_context_mcp")).toBe("chrome.tabs_context")
  })

  it("rejects non-chrome tools, including a bare unnamespaced verb", () => {
    expect(isChromeTool("Read")).toBe(false)
    expect(isChromeTool("navigate")).toBe(false)
    expect(isChromeTool("mcp__arc__arc_work_update")).toBe(false)
    expect(chromeVerb("Read")).toBe("")
  })
})
