import { describe, expect, it } from "vitest"
import { normalizeAppServerThread } from "../src/main/ingest/providers/codex-appserver/normalize.js"

// Real `item/completed` payloads + `thread/tokenUsage/updated` params captured
// from `codex app-server` (codex-cli 0.142.2) driving one turn: a prompt asking
// to write a file under a read-only sandbox, one shell exec, and a "DONE" reply.
// The reasoning item arrived with empty summary/content (no visible thinking).
const items: ReadonlyArray<unknown> = [
  {
    type: "userMessage",
    id: "5015c0d2-8c42-4e28-b950-d5d7817814a6",
    content: [
      { type: "text", text: "Using a single shell command, create a file named spike.txt containing the text hi in the current directory, then reply with exactly DONE." },
    ],
  },
  { type: "reasoning", id: "rs_0ef5", summary: [], content: [] },
  {
    type: "commandExecution",
    id: "call_h0jxrRzNJjyd8GdGvVgJbrZF",
    command: "/bin/zsh -lc \"printf 'hi\\n' > spike.txt\"",
    cwd: "/tmp/appserver-spike-LEvqUJ",
    status: "completed",
    aggregatedOutput: null,
    exitCode: 0,
  },
  { type: "agentMessage", id: "msg_0ef5", text: "DONE", phase: "final_answer" },
]

const usage: ReadonlyArray<unknown> = [
  { tokenUsage: { last: { inputTokens: 12534, outputTokens: 51 }, modelContextWindow: 258400 } },
  { tokenUsage: { last: { inputTokens: 12619, outputTokens: 71 }, modelContextWindow: 258400 } },
]

const rows = normalizeAppServerThread(items, usage, {
  nativeSessionId: "019f2af5-thread",
  workspaceRoot: "/work",
  sourcePath: "appserver:019f2af5-thread",
  model: "gpt-5.4",
})

describe("codex app-server → ExtractedRows", () => {
  it("maps user + assistant items to messages and skips empty reasoning", () => {
    expect(rows.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(rows.messages[0]?.text).toContain("create a file named spike.txt")
    const assistant = rows.messages.find((m) => m.role === "assistant")
    expect(assistant?.text).toBe("DONE")
    expect(assistant?.model).toBe("gpt-5.4")
    expect(rows.messages.some((m) => m.thinking)).toBe(false)
  })

  it("maps a commandExecution to a shell tool call with structured output", () => {
    const tool = rows.toolCalls.find((t) => t.nativeToolId === "call_h0jxrRzNJjyd8GdGvVgJbrZF")
    expect(tool).toBeDefined()
    expect(tool?.name).toBe("shell")
    expect(tool?.kind).toBe("shell")
    // exit 0 with no output → empty string (no EXEC_WRAPPER preamble to strip).
    expect(tool?.outputText).toBe("")
    expect(JSON.parse(tool!.inputJson!).command).toContain("printf 'hi")
  })

  it("prefixes a nonzero exit code, mirroring the rollout provider", () => {
    const failed = normalizeAppServerThread(
      [{ type: "commandExecution", id: "call_x", command: "false", status: "completed", exitCode: 2, aggregatedOutput: "boom\n" }],
      [],
      { nativeSessionId: "s", workspaceRoot: "/w", sourcePath: "appserver:s" },
    )
    expect(failed.toolCalls[0]?.outputText).toBe("[exit 2]\nboom\n")
  })

  it("orders tool call between the surrounding messages", () => {
    const ordinals = new Map(
      [...rows.messages, ...rows.toolCalls].map((r) => [r.id, r.ordinal] as const),
    )
    const user = rows.messages.find((m) => m.role === "user")!
    const tool = rows.toolCalls[0]!
    const assistant = rows.messages.find((m) => m.role === "assistant")!
    expect(ordinals.get(user.id)).toBeLessThan(ordinals.get(tool.id)!)
    expect(ordinals.get(tool.id)).toBeLessThan(ordinals.get(assistant.id)!)
  })

  it("projects each token-usage snapshot from its `last` delta", () => {
    expect(rows.usageEvents).toHaveLength(usage.length)
    expect(rows.usageEvents.map((u) => u.inputTokens)).toEqual([12534, 12619])
    expect(rows.usageEvents[0]?.contextWindowTokens).toBe(258400)
    expect(rows.usageEvents[0]?.contextUsedTokens).toBe(12534)
  })

  it("carries provider + session identity through finish", () => {
    expect(rows.session.provider).toBe("codex")
    expect(rows.session.nativeSessionId).toBe("019f2af5-thread")
    expect(rows.session.workspaceRoot).toBe("/work")
    expect(rows.session.title).toContain("create a file named spike.txt")
  })
})
