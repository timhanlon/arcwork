import { describe, expect, it } from "vitest"
import { normalizeClaudeSession, parseClaudeSessions } from "../src/main/ingest/providers/claude.js"

type Rec = Record<string, unknown>

// One assistant tool_use followed by a user tool_result whose `content` carries
// the given block(s). Exercises the tool_result content flattening that feeds
// ToolCallRow.outputText (and thus the tool-call lifecycle state downstream).
const session = (sessionId: string, toolName: string, resultContent: unknown): ReadonlyArray<Rec> => [
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: null,
    sessionId,
    timestamp: "2026-06-01T19:40:00.000Z",
    message: {
      content: [{ type: "tool_use", id: "toolu_1", name: toolName, input: {} }],
    },
  },
  {
    type: "user",
    uuid: "u1",
    parentUuid: "a1",
    sessionId,
    timestamp: "2026-06-01T19:40:01.000Z",
    message: {
      content: [{ type: "tool_result", tool_use_id: "toolu_1", content: resultContent }],
    },
  },
]

const outputFor = (toolName: string, resultContent: unknown): string | null => {
  const sessions = parseClaudeSessions([session("sess-tr", toolName, resultContent)])
  const rows = normalizeClaudeSession(sessions[0]!, { workspaceRoot: "/work", sourcePath: "/project" })
  return rows.toolCalls.find((t) => t.nativeToolId === "toolu_1")?.outputText ?? null
}

describe("claude tool_result content shapes", () => {
  it("flattens a plain string result", () => {
    expect(outputFor("Bash", "total 8\ndrwxr-x")).toBe("total 8\ndrwxr-x")
  })

  it("flattens text blocks", () => {
    expect(outputFor("Read", [{ type: "text", text: "file contents here" }])).toBe("file contents here")
  })

  it("flattens tool_reference blocks (ToolSearch) instead of dropping them", () => {
    const out = outputFor("ToolSearch", [
      { type: "tool_reference", tool_name: "mcp__claude-in-chrome__navigate" },
      { type: "tool_reference", tool_name: "mcp__claude-in-chrome__computer" },
    ])
    expect(out).toContain("mcp__claude-in-chrome__navigate")
    expect(out).toContain("mcp__claude-in-chrome__computer")
    // The regression: this used to be "" and projected the tool as pending forever.
    expect(out).not.toBe("")
    expect(out).not.toBeNull()
  })

  it("represents image blocks rather than dropping them", () => {
    expect(outputFor("Read", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "x" } }])).toBe(
      "[image]",
    )
  })

  it("flags an errored result", () => {
    const sessions = parseClaudeSessions([
      [
        {
          type: "assistant",
          uuid: "a1",
          parentUuid: null,
          sessionId: "sess-err",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: { content: [{ type: "tool_use", id: "toolu_e", name: "Bash", input: {} }] },
        },
        {
          type: "user",
          uuid: "u1",
          parentUuid: "a1",
          sessionId: "sess-err",
          timestamp: "2026-06-01T19:40:01.000Z",
          message: {
            content: [
              { type: "tool_result", tool_use_id: "toolu_e", is_error: true, content: "boom" },
            ],
          },
        },
      ],
    ])
    const rows = normalizeClaudeSession(sessions[0]!, { workspaceRoot: "/work", sourcePath: "/project" })
    expect(rows.toolCalls.find((t) => t.nativeToolId === "toolu_e")?.outputText).toBe("[error] boom")
  })
})
