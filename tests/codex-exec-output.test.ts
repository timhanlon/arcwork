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
})
