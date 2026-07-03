import { describe, expect, it } from "vitest"
import { normalizeClaudeSession } from "../src/main/ingest/providers/claude.js"
import { parseClaudeSessions } from "../src/main/ingest/providers/claude-dag.js"

type Rec = Record<string, unknown>

// A real assistant turn followed by a synthetic notice. Claude Code fabricates
// the second record (model "<synthetic>", no requestId) for API errors and
// interrupts; it carries an all-zero `usage` object.
const records = (sessionId: string): ReadonlyArray<Rec> => [
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId,
    timestamp: "2026-06-01T19:40:00.000Z",
    message: { content: "hello" },
  },
  {
    type: "assistant",
    uuid: "a1",
    parentUuid: "u1",
    sessionId,
    requestId: "req_real",
    timestamp: "2026-06-01T19:40:01.000Z",
    message: {
      model: "claude-opus-4-8",
      content: [{ type: "text", text: "hi" }],
      usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 8 },
    },
  },
  {
    type: "assistant",
    uuid: "a2",
    parentUuid: "a1",
    sessionId,
    timestamp: "2026-06-01T19:40:02.000Z",
    message: {
      model: "<synthetic>",
      content: [{ type: "text", text: "API Error: Overloaded" }],
      usage: { input_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 0 },
    },
  },
]

describe("claude synthetic usage", () => {
  it("skips usage for synthetic assistant records, keeping the real turn's", () => {
    const sessions = parseClaudeSessions([records("sess-synth-1")])
    expect(sessions).toHaveLength(1)

    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })

    // The all-zero synthetic record contributes no usage row — only the real turn.
    expect(rows.usageEvents).toHaveLength(1)
    const usage = rows.usageEvents[0]!
    expect(usage.model).toBe("claude-opus-4-8")
    expect(usage.nativeRequestId).toBe("req_real")
    expect(usage.contextUsedTokens).toBe(120)
    // No emitted row carries the synthetic model or a zeroed context reading that
    // would clobber the latest-usage lookup a context meter does.
    expect(rows.usageEvents.some((u) => u.model === "<synthetic>")).toBe(false)
  })
})
