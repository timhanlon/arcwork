import { describe, expect, it } from "vitest"
import { normalizeCodexRecords } from "../src/main/ingest/providers/codex.js"

type Rec = Record<string, unknown>

// A function_call paired with its function_call_output, the minimum needed to
// exercise the exec-wrapper stripping that feeds ToolCallRow.outputText.
const records = (callId: string, output: string): ReadonlyArray<Rec> => [
  {
    type: "session_meta",
    timestamp: "2026-06-01T19:40:00.000Z",
    payload: { id: "sess-1", cwd: "/work" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-01T19:40:01.000Z",
    payload: { type: "function_call", name: "shell", call_id: callId, arguments: "{}" },
  },
  {
    type: "response_item",
    timestamp: "2026-06-01T19:40:02.000Z",
    payload: { type: "function_call_output", call_id: callId, output },
  },
]

const outputFor = (output: string): string | null => {
  const rows = normalizeCodexRecords(records("call_1", output), {
    nativeSessionId: "sess-1",
    sourcePath: "/rollout.jsonl",
    workspaceRoot: "/work",
  })
  return rows.toolCalls.find((t) => t.nativeToolId === "call_1")?.outputText ?? null
}

const wrap = (code: number, body: string): string =>
  `Chunk ID: 751732\nWall time: 0.0519 seconds\nProcess exited with code ${code}\nOriginal token count: 4805\nOutput:\n${body}`

describe("codex exec-output wrapper stripping", () => {
  it("strips the telemetry preamble down to the body", () => {
    expect(outputFor(wrap(0, "src/index.ts\nsrc/app.ts\n"))).toBe("src/index.ts\nsrc/app.ts\n")
  })

  it("keeps a nonzero exit code as a compact prefix", () => {
    expect(outputFor(wrap(1, "no matches found\n"))).toBe("[exit 1]\nno matches found\n")
  })

  it("preserves a body that itself contains the wrapper's marker words", () => {
    const body = "Process exited with code 0\nOutput: this is real output\n"
    expect(outputFor(wrap(0, body))).toBe(body)
  })

  it("passes through output without the wrapper untouched", () => {
    expect(outputFor('{"_tag":"Work","id":"work_123"}')).toBe('{"_tag":"Work","id":"work_123"}')
  })

  it("joins Code Mode custom-tool content blocks into the transcript result", () => {
    const rows = normalizeCodexRecords(
      [
        {
          type: "session_meta",
          timestamp: "2026-07-14T06:08:00.000Z",
          payload: { id: "sess-code-mode", cwd: "/work" },
        },
        {
          type: "response_item",
          timestamp: "2026-07-14T06:08:01.000Z",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call_code_mode",
            input: 'const r = await tools.exec_command({"cmd":"rg code mode","workdir":"/work"}); text(r.output);',
          },
        },
        {
          type: "response_item",
          timestamp: "2026-07-14T06:08:02.000Z",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_code_mode",
            output: [
              { type: "input_text", text: "Script completed\nWall time 0.2 seconds\nOutput:\n" },
              { type: "input_text", text: "the useful result\n" },
            ],
          },
        },
      ],
      { nativeSessionId: "sess-code-mode", sourcePath: "/rollout.jsonl", workspaceRoot: "/work" },
    )

    expect(rows.toolCalls).toMatchObject([
      {
        nativeToolId: "call_code_mode",
        name: "exec_command",
        kind: "shell",
        inputJson: '{"cmd":"rg code mode","workdir":"/work"}',
        outputText: "the useful result\n",
      },
    ])
  })

  it("surfaces a failed Code Mode script as an [error] result", () => {
    const rows = normalizeCodexRecords(
      [
        { type: "session_meta", payload: { id: "sess-fail", cwd: "/work" } },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call_fail",
            input: 'const r = await tools.exec_command({"cmd":"false"}); text(r.output);',
          },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_fail",
            output: [
              { type: "input_text", text: "Script failed\nWall time 0.1 seconds\nOutput:\n" },
              { type: "input_text", text: "boom\n" },
            ],
          },
        },
      ],
      { nativeSessionId: "sess-fail", sourcePath: "/rollout.jsonl", workspaceRoot: "/work" },
    )

    expect(rows.toolCalls[0]).toMatchObject({ name: "exec_command", outputText: "[error]\nboom\n" })
  })

  it("recovers a Code Mode apply_patch bound through a const so it renders as a diff", () => {
    const patch =
      "*** Begin Patch\n*** Update File: /work/src/sidebar/ArcSidebarTree.tsx\n@@\n-  const open = true\n+  const open = false\n*** End Patch"
    const script = `const patch = ${JSON.stringify(patch)};\nconst r = await tools.apply_patch(patch);\ntext(typeof r === "string" ? r : JSON.stringify(r));\n`
    const rows = normalizeCodexRecords(
      [
        { type: "session_meta", payload: { id: "sess-patch", cwd: "/work" } },
        {
          type: "response_item",
          payload: { type: "custom_tool_call", name: "exec", call_id: "call_patch", input: script },
        },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call_output",
            call_id: "call_patch",
            output: [
              { type: "input_text", text: "Script completed\nWall time 0.4 seconds\nOutput:\n" },
              { type: "input_text", text: "Success. Updated the following files:\nM src/sidebar/ArcSidebarTree.tsx\n" },
            ],
          },
        },
      ],
      { nativeSessionId: "sess-patch", sourcePath: "/rollout.jsonl", workspaceRoot: "/work" },
    )

    expect(rows.toolCalls).toMatchObject([
      {
        name: "apply_patch",
        kind: "write",
        inputJson: JSON.stringify({ input: patch }),
        outputText: "Success. Updated the following files:\nM src/sidebar/ArcSidebarTree.tsx\n",
      },
    ])
    expect(rows.fileHints).toMatchObject([
      { path: "/work/src/sidebar/ArcSidebarTree.tsx", source: "apply_patch" },
    ])
  })

  it("recovers a Code Mode call with an inline string argument", () => {
    const rows = normalizeCodexRecords(
      [
        { type: "session_meta", payload: { id: "sess-inline", cwd: "/work" } },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call_inline",
            input: 'const r = await tools.apply_patch("*** Begin Patch\\n*** Delete File: /work/old.ts\\n*** End Patch"); text(r);',
          },
        },
      ],
      { nativeSessionId: "sess-inline", sourcePath: "/rollout.jsonl", workspaceRoot: "/work" },
    )

    expect(rows.toolCalls[0]).toMatchObject({
      name: "apply_patch",
      inputJson: JSON.stringify({ input: "*** Begin Patch\n*** Delete File: /work/old.ts\n*** End Patch" }),
    })
  })

  it("keeps a multi-call Code Mode script as an exec card", () => {
    const rows = normalizeCodexRecords(
      [
        { type: "session_meta", payload: { id: "sess-multi", cwd: "/work" } },
        {
          type: "response_item",
          payload: {
            type: "custom_tool_call",
            name: "exec",
            call_id: "call_multi",
            input:
              'await Promise.all([tools.exec_command({"cmd":"rg one"}), tools.exec_command({"cmd":"rg two"})]);',
          },
        },
      ],
      { nativeSessionId: "sess-multi", sourcePath: "/rollout.jsonl", workspaceRoot: "/work" },
    )

    expect(rows.toolCalls[0]).toMatchObject({
      name: "exec",
      inputJson: JSON.stringify({
        command: 'await Promise.all([tools.exec_command({"cmd":"rg one"}), tools.exec_command({"cmd":"rg two"})]);',
      }),
    })
  })

  it("extracts token_count records as usage events", () => {
    const rows = normalizeCodexRecords(
      [
        {
          type: "session_meta",
          timestamp: "2026-06-01T19:40:00.000Z",
          payload: { id: "sess-usage", cwd: "/work" },
        },
        {
          timestamp: "2026-06-01T19:40:03.000Z",
          type: "event_msg",
          payload: {
            type: "token_count",
            info: {
              total_token_usage: {
                input_tokens: 753835,
                cached_input_tokens: 593152,
                output_tokens: 6688,
                reasoning_output_tokens: 460,
                total_tokens: 760523,
              },
              last_token_usage: {
                input_tokens: 64119,
                cached_input_tokens: 23424,
                output_tokens: 511,
                reasoning_output_tokens: 25,
                total_tokens: 64630,
              },
              model_context_window: 258400,
            },
            rate_limits: {
              primary: { used_percent: 7 },
              secondary: { used_percent: 1 },
            },
          },
        },
      ],
      {
        nativeSessionId: "sess-usage",
        sourcePath: "/rollout.jsonl",
        workspaceRoot: "/work",
      },
    )

    expect(rows.usageEvents).toMatchObject([
      {
        id: "codex:sess-usage:usage:0",
        sessionId: "codex:sess-usage",
        provider: "codex",
        occurredAt: "2026-06-01T19:40:03.000Z",
        nativeRequestId: null,
        model: null,
        contextUsedTokens: 64119,
        contextWindowTokens: 258400,
        inputTokens: 64119,
        outputTokens: 511,
        sequence: 0,
      },
    ])
    expect(rows.usageEvents[0]?.rawJson).toContain("cached_input_tokens")
    expect(rows.usageEvents[0]?.rawJson).toContain("rate_limits")
    expect(rows.messages).toHaveLength(0)
  })
})

describe("codex session created_at", () => {
  const opts = { nativeSessionId: "sess-1", sourcePath: "/rollout.jsonl", workspaceRoot: "/work" }

  it("reads created_at from the session_meta record envelope", () => {
    const rows = normalizeCodexRecords(records("call_1", "output"), opts)
    expect(rows.session.createdAt).toBe("2026-06-01T19:40:00.000Z")
  })

  it("falls back to a legacy payload.timestamp when the envelope has none", () => {
    const rows = normalizeCodexRecords(
      [{ type: "session_meta", payload: { id: "sess-1", cwd: "/work", timestamp: "2026-06-01T10:00:00.000Z" } }],
      opts,
    )
    expect(rows.session.createdAt).toBe("2026-06-01T10:00:00.000Z")
  })
})
