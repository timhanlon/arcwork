import { describe, expect, it } from "vitest"
import { normalizeClaudeSession } from "../src/main/ingest/providers/claude.js"
import { parseClaudeSessions } from "../src/main/ingest/providers/claude-dag.js"

type Rec = Record<string, unknown>

// A programmatic prompt as Claude writes it to the transcript: a normal `type:
// user` record, but flagged `isMeta: true` — a ScheduleWakeup/`/loop` re-submission
// or a skill base-directory injection, not something the human typed.
const records = (sessionId: string): ReadonlyArray<Rec> => [
  {
    type: "user",
    uuid: "u1",
    parentUuid: null,
    sessionId,
    timestamp: "2026-06-01T19:40:00.000Z",
    message: { content: "the real first prompt" },
  },
  {
    type: "user",
    isMeta: true,
    uuid: "m1",
    parentUuid: "u1",
    sessionId,
    timestamp: "2026-06-01T19:48:00.000Z",
    message: { content: "Check the test suite and close out the work if green." },
  },
]

describe("claude meta ingest", () => {
  it("extracts isMeta user records as a meta message row", () => {
    const sessions = parseClaudeSessions([records("sess-meta-1")])
    expect(sessions).toHaveLength(1)

    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })

    const meta = rows.messages.find((m) => m.role === "meta")
    expect(meta).toBeDefined()
    expect(meta?.text).toContain("Check the test suite")
    expect(meta?.nativeMessageId).toBe("m1")
    // Shares the display ordinal space and lands after the genuine user turn.
    const user = rows.messages.find((m) => m.role === "user")
    expect(user?.text).toBe("the real first prompt")
    expect(meta!.ordinal).toBeGreaterThan(user!.ordinal)
  })

  it("does not seed the session title from a meta prompt", () => {
    // A meta prompt arriving *before* any genuine user turn must not become the
    // title — only the real prompt should.
    const sessions = parseClaudeSessions([
      [
        {
          type: "user",
          isMeta: true,
          uuid: "m1",
          parentUuid: null,
          sessionId: "sess-meta-2",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: { content: "Base directory for this skill: /skills/foo" },
        },
        {
          type: "user",
          uuid: "u1",
          parentUuid: "m1",
          sessionId: "sess-meta-2",
          timestamp: "2026-06-01T19:41:00.000Z",
          message: { content: "what the human actually asked" },
        },
      ],
    ])

    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })
    expect(rows.session.title).toBe("what the human actually asked")
  })

  it("summarizes skill-read meta prompts instead of storing the full skill body", () => {
    const sessions = parseClaudeSessions([
      [
        {
          type: "user",
          isMeta: true,
          uuid: "m1",
          parentUuid: null,
          sessionId: "sess-meta-3",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: {
            content: [
              "Base directory for this skill: /Users/you/dev/aux/.claude/skills/arc-work",
              "# arc-work",
              "Long internal instructions that should not appear in the chat UI.",
            ].join("\n"),
          },
        },
        {
          type: "user",
          uuid: "u1",
          parentUuid: "m1",
          sessionId: "sess-meta-3",
          timestamp: "2026-06-01T19:41:00.000Z",
          message: { content: "real user prompt" },
        },
      ],
    ])

    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })
    const meta = rows.messages.find((m) => m.role === "meta")
    expect(meta?.text).toBe("Read skill: arc-work")
  })

  it("collapses a slash-command wrapper to the typed command line", () => {
    // Claude wraps a typed slash command in harness tags. Projecting them
    // verbatim shows the raw markup and misses reconciliation with the composer
    // echo (which holds the clean `/commit before fixes`); collapse to that.
    const sessions = parseClaudeSessions([
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "sess-cmd-1",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: {
            content:
              "<command-message>commit</command-message>\n<command-name>/commit</command-name>\n<command-args>before fixes</command-args>",
          },
        },
      ],
    ])
    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })
    const user = rows.messages.find((m) => m.role === "user")
    expect(user?.text).toBe("/commit before fixes")
    // The cleaned command also seeds the title rather than the raw tags.
    expect(rows.session.title).toBe("/commit before fixes")
  })

  it("collapses an argless slash command and drops its <command-args>", () => {
    const sessions = parseClaudeSessions([
      [
        {
          type: "user",
          uuid: "u1",
          parentUuid: null,
          sessionId: "sess-cmd-2",
          timestamp: "2026-06-01T19:40:00.000Z",
          message: {
            content:
              "<command-name>/clear</command-name>\n            <command-message>clear</command-message>\n            <command-args></command-args>",
          },
        },
      ],
    ])
    const rows = normalizeClaudeSession(sessions[0]!, {
      workspaceRoot: "/work",
      sourcePath: "/project",
    })
    const user = rows.messages.find((m) => m.role === "user")
    expect(user?.text).toBe("/clear")
  })
})
