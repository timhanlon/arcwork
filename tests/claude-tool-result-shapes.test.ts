import { describe, expect, it } from "vitest"
import { normalizeClaudeSession } from "../src/main/ingest/providers/claude.js"
import { parseClaudeSessions } from "../src/main/ingest/providers/claude-dag.js"

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

  it("captures image blocks as a content-addressed reference, not [image] text", () => {
    const sessions = parseClaudeSessions([
      session("sess-img", "Read", [{ type: "image", source: { type: "base64", media_type: "image/png", data: "aGVsbG8=" } }]),
    ])
    const rows = normalizeClaudeSession(sessions[0]!, { workspaceRoot: "/work", sourcePath: "/project" })
    const call = rows.toolCalls.find((t) => t.nativeToolId === "toolu_1")!
    // No "[image]" placeholder — an image-only result leaves outputText null and
    // carries the picture instead (the projection treats images as completion).
    expect(call.outputText).toBeNull()
    const images = JSON.parse(call.imagesJson!) as Array<{ readonly hash: string; readonly mediaType: string }>
    expect(images).toHaveLength(1)
    expect(images[0]!.mediaType).toBe("image/png")
    expect(images[0]!.hash).toMatch(/^[a-f0-9]{64}$/)
    // The bytes ride the sibling `images` collection for the store to persist.
    expect(rows.images).toHaveLength(1)
    expect(rows.images![0]!.data).toBe("aGVsbG8=")
    expect(rows.images![0]!.toolCallId).toBe(call.id)
  })

  it("keeps sibling text alongside an image (browser screenshot shape)", () => {
    const sessions = parseClaudeSessions([
      session("sess-shot", "mcp__claude-in-chrome__computer", [
        { type: "text", text: "captured screenshot" },
        { type: "image", source: { type: "base64", media_type: "image/jpeg", data: "eHk=" } },
      ]),
    ])
    const rows = normalizeClaudeSession(sessions[0]!, { workspaceRoot: "/work", sourcePath: "/project" })
    const call = rows.toolCalls.find((t) => t.nativeToolId === "toolu_1")!
    expect(call.outputText).toBe("captured screenshot")
    expect(JSON.parse(call.imagesJson!)).toHaveLength(1)
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

  it("extracts one final usage event per assistant request", () => {
    const sessions = parseClaudeSessions([
      [
        {
          type: "assistant",
          uuid: "a1",
          requestId: "req_1",
          parentUuid: null,
          sessionId: "sess-usage",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: {
            model: "claude-opus-4-8",
            content: [{ type: "thinking", thinking: "..." }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 30,
              output_tokens: 4,
            },
          },
        },
        {
          type: "assistant",
          uuid: "a2",
          requestId: "req_1",
          parentUuid: "a1",
          sessionId: "sess-usage",
          timestamp: "2026-06-01T19:40:01.000Z",
          message: {
            model: "claude-opus-4-8",
            content: [{ type: "text", text: "done" }],
            usage: {
              input_tokens: 10,
              cache_read_input_tokens: 20,
              cache_creation_input_tokens: 30,
              output_tokens: 40,
            },
          },
        },
      ],
    ])

    const rows = normalizeClaudeSession(sessions[0]!, { workspaceRoot: "/work", sourcePath: "/project" })
    expect(rows.usageEvents).toMatchObject([
      {
        id: "claude:sess-usage:usage:0",
        sessionId: "claude:sess-usage",
        provider: "claude",
        occurredAt: "2026-06-01T19:40:01.000Z",
        nativeRequestId: "req_1",
        model: "claude-opus-4-8",
        contextUsedTokens: 60,
        contextWindowTokens: null,
        inputTokens: 10,
        outputTokens: 40,
        sequence: 0,
      },
    ])
    expect(rows.usageEvents[0]?.rawJson).toContain("cache_creation_input_tokens")
  })
})
