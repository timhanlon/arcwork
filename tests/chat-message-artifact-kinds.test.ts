import { Effect } from "effect"
import { describe, expect, it } from "vitest"
import {
  ARTIFACT_KINDS,
  type ArtifactProjectionContext,
  type ArtifactRowSpec,
} from "../src/main/services/chat-message/artifact-projection.js"
import type { ExtractedRows, MessageRow, ToolCallRow } from "../src/main/ingest/db/schema.js"
import { arcId } from "../src/shared/ids.js"

const TARGET = { id: arcId("target", "target_1"), chatId: arcId("chat", "chat_1") }

const message = (over: Partial<MessageRow>): MessageRow => ({
  id: "msg",
  sessionId: "session_1",
  provider: "claude",
  nativeMessageId: null,
  role: "assistant",
  createdAt: null,
  model: null,
  text: null,
  thinking: null,
  rawJson: null,
  sequence: 0,
  ordinal: 0,
  ...over,
})

const toolCall = (over: Partial<ToolCallRow>): ToolCallRow => ({
  id: "tool",
  sessionId: "session_1",
  messageId: null,
  provider: "claude",
  nativeToolId: null,
  name: "Bash",
  kind: "generic",
  inputJson: null,
  outputText: null,
  rawJson: null,
  sequence: 0,
  ordinal: 0,
  ...over,
})

const extracted = (over: Partial<ExtractedRows>): ExtractedRows => ({
  session: {
    id: "session_1",
    provider: "claude",
    nativeSessionId: "sess_1",
    workspaceRoot: "/tmp/ws",
    title: null,
    createdAt: null,
    updatedAt: null,
    sourcePath: null,
    rawMetadataJson: null,
  },
  messages: [],
  toolCalls: [],
  fileHints: [],
  diagnostics: [],
  ...over,
})

const context = (rows: ExtractedRows, over: Partial<ArtifactProjectionContext> = {}): ArtifactProjectionContext => ({
  rows,
  target: TARGET,
  projected: [],
  projectionTime: "2026-06-11T12:00:00.000Z",
  relabelHookUserAsMeta: () => Effect.succeed(false),
  ...over,
})

const allSpecs = (ctx: ArtifactProjectionContext): Array<ArtifactRowSpec> =>
  ARTIFACT_KINDS.flatMap((kind) => [...kind(ctx)])

describe("artifact projection kinds", () => {
  it("interleaves a tool call between its native-timed message neighbours", () => {
    const rows = extracted({
      messages: [
        message({ id: "u", role: "user", text: "go", ordinal: 0, createdAt: "2026-06-11T00:00:00.000Z" }),
        message({ id: "a", role: "assistant", text: "done", ordinal: 2, createdAt: "2026-06-11T00:00:10.000Z" }),
      ],
      toolCalls: [toolCall({ nativeToolId: "t1", ordinal: 1, outputText: "ok" })],
    })
    const specs = allSpecs(context(rows))
    const tool = specs.find((s) => s.role === "tool")
    expect(tool).toBeDefined()
    // The tool lands strictly after the preceding user message and before the
    // following assistant message, preserving the source interleaving.
    expect(tool!.occurredAt > "2026-06-11T00:00:00.000Z").toBe(true)
    expect(tool!.occurredAt < "2026-06-11T00:00:10.000Z").toBe(true)
  })

  it("spreads no-native-time records by ordinal off the stable session time", () => {
    const rows = extracted({
      session: {
        ...extracted({}).session,
        createdAt: "2026-06-11T00:00:00.000Z",
      },
      toolCalls: [
        toolCall({ id: "x", nativeToolId: "t0", ordinal: 0, outputText: "a" }),
        toolCall({ id: "y", nativeToolId: "t1", ordinal: 1, outputText: "b" }),
      ],
    })
    const tools = allSpecs(context(rows)).filter((s) => s.role === "tool")
    const byKey = Object.fromEntries(tools.map((t) => [t.dedupKey, t.occurredAt]))
    expect(byKey["target_1:tool:t0"]).toBe("2026-06-11T00:00:00.000Z")
    expect(byKey["target_1:tool:t1"]).toBe("2026-06-11T00:00:00.001Z")
    expect(byKey["target_1:tool:t0"]! < byKey["target_1:tool:t1"]!).toBe(true)
  })

  it("keeps Cursor fallback times stable across projection passes", () => {
    const rows = extracted({
      session: {
        ...extracted({}).session,
        provider: "cursor",
        createdAt: "2026-06-17T00:32:33.938Z",
      },
      messages: [
        message({ id: "u", provider: "cursor", role: "user", text: "find all files over 500 lines", ordinal: 0 }),
        message({ id: "a", provider: "cursor", role: "assistant", text: "Searching the repo.", ordinal: 1 }),
      ],
      toolCalls: [
        toolCall({
          id: "shell",
          provider: "cursor",
          nativeToolId: "tool_shell",
          name: "Shell",
          ordinal: 2,
        }),
      ],
    })

    const first = allSpecs(context(rows, { projectionTime: "2026-06-17T00:34:52.000Z" }))
    const second = allSpecs(context(rows, { projectionTime: "2026-06-17T00:35:52.000Z" }))
    const times = (specs: Array<ArtifactRowSpec>) =>
      specs
        .map((s) => ({ role: s.role, occurredAt: s.occurredAt }))
        .sort((a, b) => a.occurredAt.localeCompare(b.occurredAt))

    expect(times(first)).toEqual([
      { role: "user", occurredAt: "2026-06-17T00:32:33.938Z" },
      { role: "assistant", occurredAt: "2026-06-17T00:32:33.939Z" },
      { role: "tool", occurredAt: "2026-06-17T00:32:33.940Z" },
    ])
    expect(times(second)).toEqual(times(first))
  })

  it("projects a question tool as a request row with a structured payload", () => {
    const rows = extracted({
      toolCalls: [
        toolCall({
          nativeToolId: "q1",
          name: "AskUserQuestion",
          inputJson: JSON.stringify({ questions: [{ question: "Cats or dogs?", options: [{ label: "Cats" }, { label: "Dogs" }] }] }),
          outputText: 'Your questions have been answered: "Cats or dogs?"="Cats".',
        }),
      ],
    })
    const request = allSpecs(context(rows)).find((s) => s.role === "request")
    expect(request).toBeDefined()
    expect(request!.requestJson && JSON.parse(request!.requestJson).kind).toBe("question")
  })

  it("wires the composer-echo reconcile onto user rows only when provided", () => {
    const rows = extracted({ messages: [message({ id: "u", role: "user", text: "hi", nativeMessageId: "uid" })] })

    const without = allSpecs(context(rows)).find((s) => s.role === "user")
    expect(without?.reconcile).toBeUndefined()

    const with_ = allSpecs(
      context(rows, { reconcileComposerUser: () => Effect.succeed(true) }),
    ).find((s) => s.role === "user")
    expect(with_?.reconcile).toBeDefined()
  })

  it("always wires the hook-user -> meta relabel onto meta rows", () => {
    const rows = extracted({ messages: [message({ id: "m", role: "meta", text: "/loop", nativeMessageId: "mid" })] })
    const meta = allSpecs(context(rows)).find((s) => s.role === "meta")
    expect(meta?.reconcile).toBeDefined()
  })
})
