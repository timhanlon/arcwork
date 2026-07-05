import { describe, expect, it } from "vitest"
import { type AcpItem, normalizeAcpSession } from "../src/main/ingest/providers/cursor-acp/normalize.js"

// The driver's pre-folded item list for one ACP turn: a synthesized user
// message, a completed execute tool (command + exit + output), and the flushed
// assistant reply. Mirrors what the `session/update` fold produces.
const items: ReadonlyArray<AcpItem> = [
  { kind: "message", role: "user", text: "Run echo hello-acp then say DONE." },
  {
    kind: "tool",
    toolCallId: "tool_5f739001",
    title: "`echo hello-acp`",
    toolKind: "execute",
    command: "echo hello-acp",
    exitCode: 0,
    output: "hello-acp\n",
    input: { command: "echo hello-acp" },
  },
  { kind: "message", role: "assistant", text: "DONE" },
]

const rows = normalizeAcpSession(items, {
  nativeSessionId: "441efc01-session",
  workspaceRoot: "/work",
  sourcePath: "acp:441efc01-session",
  model: "cursor-default",
})

describe("cursor ACP → ExtractedRows", () => {
  it("maps the synthesized user + assistant items to messages", () => {
    expect(rows.messages.map((m) => m.role)).toEqual(["user", "assistant"])
    expect(rows.messages[0]?.text).toContain("hello-acp")
    const assistant = rows.messages.find((m) => m.role === "assistant")
    expect(assistant?.text).toBe("DONE")
    expect(assistant?.model).toBe("cursor-default")
  })

  it("maps an execute tool to a shell tool call with structured output", () => {
    const tool = rows.toolCalls.find((t) => t.nativeToolId === "tool_5f739001")
    expect(tool?.name).toBe("Shell")
    expect(tool?.kind).toBe("shell")
    expect(tool?.outputText).toBe("hello-acp\n")
    expect(JSON.parse(tool!.inputJson!).command).toBe("echo hello-acp")
  })

  it("prefixes a nonzero exit code, mirroring the codex path", () => {
    const failed = normalizeAcpSession(
      [
        {
          kind: "tool",
          toolCallId: "t2",
          title: "`false`",
          toolKind: "execute",
          command: "false",
          exitCode: 2,
          output: "boom\n",
          input: { command: "false" },
        },
      ],
      { nativeSessionId: "s", workspaceRoot: "/w", sourcePath: "acp:s" },
    )
    expect(failed.toolCalls[0]?.outputText).toBe("[exit 2]\nboom\n")
  })

  it("orders the tool call between the surrounding messages", () => {
    const ordinals = new Map([...rows.messages, ...rows.toolCalls].map((r) => [r.id, r.ordinal] as const))
    const user = rows.messages.find((m) => m.role === "user")!
    const tool = rows.toolCalls[0]!
    const assistant = rows.messages.find((m) => m.role === "assistant")!
    expect(ordinals.get(user.id)).toBeLessThan(ordinals.get(tool.id)!)
    expect(ordinals.get(tool.id)).toBeLessThan(ordinals.get(assistant.id)!)
  })

  it("carries cursor provider + session identity through finish", () => {
    expect(rows.session.provider).toBe("cursor")
    expect(rows.session.nativeSessionId).toBe("441efc01-session")
    expect(rows.session.sourcePath).toBe("acp:441efc01-session")
    expect(rows.usageEvents).toHaveLength(0)
  })
})
