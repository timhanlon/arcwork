import { describe, expect, it } from "vitest"
import { arcVerb, arcToolLabel, isArcTool } from "../src/renderer/src/chat/tool-calls/arc-tool-name.js"

// The renderer must recognise arc MCP tool calls across the name shapes the target
// CLIs flatten them into (Claude `mcp__arc__arc_*`, Cursor's plugin server
// `mcp_plugin-arc-work-arc_arc_*`, Codex bare `arc_*`) and recover the same verb
// from each, so a `work.update` call renders identically whoever made it. Pure
// string logic; see arc-tool-name.ts.

describe("arc tool-name parsing across CLI formats", () => {
  const cases = [
    { cli: "Claude", name: "mcp__arc__arc_work_update" },
    { cli: "Cursor", name: "mcp_plugin-arc-work-arc_arc_work_update" },
    { cli: "Codex", name: "arc_work_update" },
  ] as const

  for (const { cli, name } of cases) {
    it(`recognises and labels the ${cli} flattening`, () => {
      expect(isArcTool(name)).toBe(true)
      // Dispatch key stays flattened; the header label restores the public dotted name.
      expect(arcVerb(name)).toBe("work_update")
      expect(arcToolLabel(name)).toBe("arc.work.update")
    })
  }

  it("recovers the same verb from every format", () => {
    const verbs = cases.map((c) => arcVerb(c.name))
    expect(new Set(verbs).size).toBe(1)
  })

  it("handles other arc verbs and the create door", () => {
    expect(arcVerb("arc_work_create")).toBe("work_create")
    expect(arcVerb("mcp__arc__arc_search")).toBe("search")
    expect(arcVerb("mcp_plugin-arc-work-arc_arc_handoff_report")).toBe("handoff_report")
  })

  it("still recognises Cursor's legacy home `~/.cursor/mcp.json` server shape", () => {
    // The orchestrated path uses the plugin server; a manually-configured home
    // server named "arc" emits `mcp_arc_arc_*` and must keep rendering as arc.
    expect(isArcTool("mcp_arc_arc_work_update")).toBe(true)
    expect(arcVerb("mcp_arc_arc_prime")).toBe("prime")
    expect(arcToolLabel("mcp_plugin-arc-work-arc_arc_work_update")).toBe("arc.work.update")
  })

  it("labels the dotted public names for create/update, leaving real underscores intact", () => {
    // `work.create` / `work.update` flatten to underscores on the wire; the header
    // restores the dotted public name.
    expect(arcToolLabel("arc_work_create")).toBe("arc.work.create")
    expect(arcToolLabel("mcp__arc__arc_work_create")).toBe("arc.work.create")
    // Verbs whose underscores are genuine stay as-is — historical calls and
    // multi-word verbs that were never dotted in the public name.
    expect(arcToolLabel("mcp__arc__arc_work_comment")).toBe("arc.work_comment")
    expect(arcToolLabel("arc_handoff_report")).toBe("arc.handoff_report")
  })

  it("rejects non-arc tools, including lookalikes", () => {
    // A plain first-party tool, and a Codex tool whose name merely starts with
    // "arc" but isn't the `arc_` server prefix — neither should be claimed.
    expect(isArcTool("Read")).toBe(false)
    expect(isArcTool("mcp__claude-in-chrome__navigate")).toBe(false)
    expect(isArcTool("archive_thing")).toBe(false)
    expect(isArcTool("mcp_archive_foo")).toBe(false)
  })
})
