import { describe, expect, it } from "vitest"
import type { Provider } from "../src/shared/provider.js"
import { classifyTool, isMcpTool, lookupTool, renderShapeFor, TOOL_CATALOG } from "../src/shared/tool-catalog.js"
import { sampleKey, TOOL_SAMPLES } from "../src/shared/tool-catalog.samples.js"
import observed from "./fixtures/observed-tools.json" with { type: "json" }

// The catalog is the single source of truth for (provider, tool) → rendering →
// story coverage. These tests keep the three axes honest: every row classifies,
// every row has a Storybook/test sample, and every tool we have actually
// observed in ingested transcripts is a known row (MCP excepted — it is a
// prefix rule, not an enumerated family, so new MCP servers never churn this).

const observedTools = observed as ReadonlyArray<{ readonly provider: Provider; readonly name: string }>

describe("tool catalog", () => {
  it("has no duplicate (provider, name) rows", () => {
    const keys = TOOL_CATALOG.map((entry) => `${entry.provider}:${entry.name.toLowerCase()}`)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it("classifies every row consistently with its kind", () => {
    for (const entry of TOOL_CATALOG) {
      expect(classifyTool(entry.provider, entry.name)).toBe(entry.kind)
    }
  })

  it("renders every row according to its render shape", () => {
    for (const entry of TOOL_CATALOG) {
      expect(renderShapeFor(entry.provider, entry.name)).toBe(entry.render)
    }
  })

  it("never enumerates MCP tools (they are a prefix rule)", () => {
    expect(TOOL_CATALOG.some((entry) => isMcpTool(entry.name.toLowerCase()))).toBe(false)
    expect(classifyTool("claude", "mcp__claude-in-chrome__navigate")).toBe("mcp")
    expect(renderShapeFor("claude", "mcp__claude-in-chrome__navigate")).toBe("fallback")
  })

  it("has a Storybook/test sample for every row", () => {
    const missing = TOOL_CATALOG.filter((entry) => !(sampleKey(entry.provider, entry.name) in TOOL_SAMPLES))
      .map((entry) => sampleKey(entry.provider, entry.name))
    expect(missing).toEqual([])
  })

  it("knows every tool observed in ingested transcripts", () => {
    const unknown = observedTools.filter((tool) => !lookupTool(tool.provider, tool.name))
      .map((tool) => `${tool.provider}:${tool.name}`)
    expect(unknown).toEqual([])
  })

  it("has no samples for unknown rows", () => {
    const orphans = Object.keys(TOOL_SAMPLES).filter(
      (key) => !TOOL_CATALOG.some((entry) => sampleKey(entry.provider, entry.name) === key),
    )
    expect(orphans).toEqual([])
  })
})
