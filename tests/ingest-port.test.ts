import { describe, expect, it } from "vitest"
import { normalizeCursorBlobs } from "../src/main/ingest/providers/cursor.js"
import type { ExtractedRows } from "../src/main/ingest/db/schema.js"

const opts = (nativeSessionId: string) => ({
  nativeSessionId,
  sourcePath: "/tmp/store.db",
  workspaceRoot: "/tmp/workspace",
  createdAt: "2026-06-04T00:00:00.000Z",
})

const timeline = (rows: ExtractedRows) =>
  [
    ...rows.messages.map((m) => ({
      kind: "msg" as const,
      role: m.role,
      ordinal: m.ordinal,
      preview: (m.text ?? m.thinking ?? "").slice(0, 80),
    })),
    ...rows.toolCalls.map((t) => ({
      kind: "tool" as const,
      role: "tool" as const,
      ordinal: t.ordinal,
      preview: t.name ?? "?",
    })),
  ].sort((a, b) => a.ordinal - b.ordinal)

describe("ported artifact ingest", () => {
  it("preserves Cursor AskQuestion tool-call results from store.db-shaped blobs", async () => {
    const rows = normalizeCursorBlobs(
      [
        {
          id: "assistant-1",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tool_ask",
              toolName: "AskQuestion",
              args: {
                title: "Temperature check",
                questions: [
                  {
                    id: "temperature",
                    prompt: "Is it hot or cold?",
                    options: [
                      { id: "hot", label: "Hot" },
                      { id: "cold", label: "Cold" },
                    ],
                  },
                ],
              },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool_ask",
              toolName: "AskQuestion",
              result:
                "User questions responses:\nQuestion temperature: Selected option(s) cold",
            },
          ],
        },
      ],
      {
        nativeSessionId: "cursor-session-ask",
        sourcePath: "/tmp/store.db",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-06-04T00:00:00.000Z",
      },
    )

    expect(rows.toolCalls).toHaveLength(1)
    expect(rows.toolCalls[0]?.name).toBe("AskQuestion")
    expect(rows.toolCalls[0]?.outputText).toContain("Selected option(s) cold")
  })

  it("resolves MCP tool calls whose result is a structured object (not a string)", () => {
    // Built-in Cursor tools store `result` as a string, but MCP tools store the
    // unwrapped object/array return value. The old `str(result)` coercion dropped
    // it, leaving every MCP call stuck on "pending".
    const rows = normalizeCursorBlobs(
      [
        {
          id: "assistant-1",
          role: "assistant",
          content: [
            {
              type: "tool-call",
              toolCallId: "tool_mcp",
              toolName: "mcp_arc_arc_get",
              args: { ref: "work_123" },
            },
          ],
        },
        {
          role: "tool",
          content: [
            {
              type: "tool-result",
              toolCallId: "tool_mcp",
              toolName: "mcp_arc_arc_get",
              result: { entities: [{ id: "work_123" }], notFound: [] },
            },
          ],
        },
      ],
      {
        nativeSessionId: "cursor-session-mcp",
        sourcePath: "/tmp/store.db",
        workspaceRoot: "/tmp/workspace",
        createdAt: "2026-06-04T00:00:00.000Z",
      },
    )

    expect(rows.toolCalls).toHaveLength(1)
    expect(rows.toolCalls[0]?.kind).toBe("mcp")
    // Resolved (has output), not pending; the object is serialized to JSON.
    expect(rows.toolCalls[0]?.outputText).toBeTruthy()
    expect(rows.toolCalls[0]?.outputText).toContain("work_123")
    expect(JSON.parse(rows.toolCalls[0]!.outputText!)).toEqual({
      entities: [{ id: "work_123" }],
      notFound: [],
    })
  })

  it("preserves Cursor DAG order across multi-blob assistant turns", () => {
    const rows = normalizeCursorBlobs(
      [
        {
          role: "user",
          content: [{ type: "text", text: "<user_query>go</user_query>" }],
        },
        {
          role: "assistant",
          content: [
            { type: "redacted-reasoning", data: "hidden-a" },
            { type: "tool-call", toolCallId: "t_read", toolName: "Read", args: { path: "a.ts" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "t_read", result: "file contents" }],
        },
        {
          role: "assistant",
          content: [
            { type: "redacted-reasoning", data: "hidden-b" },
            { type: "text", text: "Done reading." },
          ],
        },
        {
          role: "user",
          content: [{ type: "text", text: "<user_query>next turn</user_query>" }],
        },
      ],
      opts("cursor-session-source-order"),
    )
    const ord = timeline(rows).map((row) =>
      row.kind === "tool" ? `tool:${row.preview}` : `${row.role}:${row.preview}`,
    )

    expect(ord).toEqual([
      "user:go",
      "tool:Read",
      "assistant:Done reading.",
      "user:next turn",
    ])
  })

  it("keeps final assistant text after preceding tool-only blobs", () => {
    const rows = normalizeCursorBlobs([
      {
        role: "user",
        content: [{ type: "text", text: "<user_query>go</user_query>" }],
      },
      {
        role: "assistant",
        content: [
          { type: "redacted-reasoning", data: "hidden-a" },
          { type: "tool-call", toolCallId: "t_read", toolName: "Read", args: { path: "a.ts" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t_read", result: "file contents" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "First pass." }],
      },
      {
        role: "assistant",
        content: [
          { type: "redacted-reasoning", data: "hidden-b" },
          { type: "tool-call", toolCallId: "t_final_a", toolName: "Shell", args: { command: "wc -l a" } },
          { type: "tool-call", toolCallId: "t_final_b", toolName: "Shell", args: { command: "wc -l b" } },
        ],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t_final_a", result: "a" }],
      },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "t_final_b", result: "b" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Final answer." }],
      },
    ], opts("cursor-session-final-tools"))
    const ord = timeline(rows).map((row) =>
      row.kind === "tool" ? `tool:${row.preview}` : `${row.role}:${row.preview}`,
    )

    expect(ord).toEqual([
      "user:go",
      "tool:Read",
      "assistant:First pass.",
      "tool:Shell",
      "tool:Shell",
      "assistant:Final answer.",
    ])
  })

  it("does not invent assistant anchors for redacted-reasoning tool blobs", () => {
    const rows = normalizeCursorBlobs(
      [
        {
          role: "user",
          content: [{ type: "text", text: "<user_query>read work_123</user_query>" }],
        },
        {
          role: "assistant",
          content: [
            { type: "redacted-reasoning", data: "encrypted-blob" },
            { type: "tool-call", toolCallId: "t_get", toolName: "mcp_arc_arc_get", args: { ref: "work_123" } },
          ],
        },
        {
          role: "tool",
          content: [{ type: "tool-result", toolCallId: "t_get", result: "ok" }],
        },
        {
          role: "assistant",
          content: [{ type: "text", text: "Here is the work item summary." }],
        },
      ],
      opts("cursor-session-redacted-anchor"),
    )

    const ord = timeline(rows)
    expect(ord.map((row) => `${row.kind}:${row.role}:${row.preview.slice(0, 24)}`)).toEqual([
      "msg:user:read work_123",
      "tool:tool:mcp_arc_arc_get",
      "msg:assistant:Here is the work item su",
    ])
    expect(rows.messages.some((m) => m.thinking === "…")).toBe(false)
    expect(rows.toolCalls[0]?.ordinal).toBeLessThan(rows.messages.find((m) => m.role === "assistant")!.ordinal)
  })

  it("keeps visible text before tools inside a single assistant blob", () => {
    const rows = normalizeCursorBlobs(
      [
        {
          role: "user",
          content: [{ type: "text", text: "<user_query>run</user_query>" }],
        },
        {
          role: "assistant",
          content: [
            { type: "text", text: "I'll inspect the file." },
            { type: "tool-call", toolCallId: "t1", toolName: "Read", args: {} },
          ],
        },
      ],
      opts("cursor-session-intra-blob"),
    )

    const ord = timeline(rows).map((row) => row.kind)
    expect(ord).toEqual(["msg", "msg", "tool"])
    expect(rows.messages.find((m) => m.role === "assistant")?.text).toBe("I'll inspect the file.")
    expect(rows.toolCalls[0]?.ordinal).toBeGreaterThan(rows.messages.find((m) => m.role === "assistant")!.ordinal)
  })
})
