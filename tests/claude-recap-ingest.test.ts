import { describe, expect, it } from "vitest"
import { normalizeClaudeSession, parseClaudeSessions } from "../src/main/ingest/providers/claude.js"

type Rec = Record<string, unknown>

// A return-from-away recap as Claude writes it to the transcript JSONL: a
// `system`/`away_summary` record (isSidechain:false) with the Goal/Next summary
// in top-level `content`. It carries uuid/sessionId/timestamp/parentUuid, so it
// survives the dedup -> DAG pipeline and reaches normalization.
const records = (sessionId: string): ReadonlyArray<Rec> => [
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId,
    timestamp: "2026-06-01T19:40:00.000Z",
    message: { content: "start the work" },
  },
  {
    type: "system",
    subtype: "away_summary",
    isSidechain: false,
    uuid: "r1",
    parentUuid: "u1",
    sessionId,
    timestamp: "2026-06-01T19:48:51.124Z",
    content: "Goal: extract usage data. Next: pick a storage shape. (disable recaps in /config)",
  },
]

describe("claude recap ingest", () => {
  it("extracts away_summary as a recap message row", () => {
    const sessions = parseClaudeSessions([records("sess-recap-1")])
    expect(sessions).toHaveLength(1)

    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })

    const recap = rows.messages.find((m) => m.role === "recap")
    expect(recap).toBeDefined()
    expect(recap?.text).toContain("Goal: extract usage data.")
    expect(recap?.nativeMessageId).toBe("r1")
    expect(recap?.createdAt).toBe("2026-06-01T19:48:51.124Z")
    // The recap shares the display ordinal space and lands after the user row.
    const user = rows.messages.find((m) => m.role === "user")
    expect(recap!.ordinal).toBeGreaterThan(user!.ordinal)
  })

  it("ignores other system subtypes (e.g. stop_hook_summary)", () => {
    const sessions = parseClaudeSessions([
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "sess-recap-2",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: { content: "go" },
        },
        {
          type: "system",
          subtype: "stop_hook_summary",
          uuid: "s1",
          parentUuid: "u1",
          sessionId: "sess-recap-2",
          timestamp: "2026-06-01T19:41:00.000Z",
          content: "hook ran",
        },
      ],
    ])

    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })
    expect(rows.messages.some((m) => m.role === "recap")).toBe(false)
  })
})
