import { describe, expect, it } from "vitest"
import { toSignal } from "../src/main/hooks/signals.js"
import {
  commitCitationNote,
  commitFromSignal,
  isCommitSignal,
  pickWorkForCommit,
} from "../src/main/hooks/commit.js"
import type { Work, WorkStatus } from "../src/shared/work.js"
import { arcId } from "../src/shared/ids.js"

/**
 * The git `post-commit` hook ships a wire record (commit metadata in `hookInput`,
 * provider "git") over the same socket the provider hooks use. These tests pin
 * the signal → CommitFact mapping and the "which work does the commit land on"
 * heuristic — the pure core of the commit→work citation feature.
 */

/** A wire line shaped exactly like `.githooks/arc-commit-payload.mjs` piped
 * through the generated `arc-hook-signal.mjs` would produce. */
const commitWire = (over: { hookInput?: Record<string, unknown> } & Record<string, unknown> = {}): string => {
  const { hookInput: hookInputOver = {}, ...topOver } = over
  return JSON.stringify({
    schemaVersion: 1,
    helperVersion: 1,
    declaredProvider: "git",
    declaredEvent: "post-commit",
    observedAt: "2026-06-17T00:00:00.000Z",
    cwd: "/repo",
    pid: 123,
    argv: ["node", "arc-hook-signal.mjs", "git", "post-commit"],
    hookInput: {
      hook_event_name: "post-commit",
      sha: "b04086fdeadbeef",
      branch: "dev",
      subject: "fix(ids): drop shortId",
      message: "fix(ids): drop shortId\n\nit truncated typeids",
      author: { name: "Tim Hanlon", email: "tim@timhanlon.com" },
      committedAt: "2026-06-17T01:00:00+10:00",
      files: ["src/a.ts", "src/b.ts"],
      ...hookInputOver,
    },
    hookInputParseOk: true,
    arc: { chatId: "chat_1", targetSessionId: "target_1", targetProvider: "claude", hookSockPresent: true },
    ...topOver,
  })
}

const signalFrom = (over: { hookInput?: Record<string, unknown> } & Record<string, unknown> = {}) => {
  const parsed = toSignal(commitWire(over))
  if (!parsed.ok) throw new Error(`bad fixture: ${parsed.reason}`)
  return parsed.signal
}

const workRow = (over: Partial<Work> & Pick<Work, "id" | "status" | "updatedAt">): Work => ({
  _tag: "Work",
  nodeId: arcId("work_rev", `${over.id}_node`),
  title: "w",
  body: "",
  labels: [],
  priority: null,
  createdAt: over.updatedAt,
  citations: [],
  provenance: { source: "mcp" },
  ...over,
})

describe("commit signal → fact", () => {
  it("recognizes a git post-commit signal carrying a sha", () => {
    const signal = signalFrom()
    expect(signal.provider).toBe("git")
    expect(isCommitSignal(signal)).toBe(true)
  })

  it("does not treat a sha-less git event as a commit signal", () => {
    expect(isCommitSignal(signalFrom({ hookInput: { sha: "" } }))).toBe(false)
  })

  it("does not treat a real provider signal as a commit signal", () => {
    const claude = toSignal(
      JSON.stringify({
        declaredProvider: "claude",
        declaredEvent: "Stop",
        hookInput: { session_id: "s", transcript_path: "/x/.claude/p/s.jsonl" },
        arc: { chatId: "chat_1", targetSessionId: "target_1", targetProvider: "claude" },
      }),
    )
    expect(claude.ok && isCommitSignal(claude.signal)).toBe(false)
  })

  it("extracts the structured commit fact", () => {
    const commit = commitFromSignal(signalFrom())
    expect(commit).toEqual({
      sha: "b04086fdeadbeef",
      branch: "dev",
      subject: "fix(ids): drop shortId",
      message: "fix(ids): drop shortId\n\nit truncated typeids",
      author: { name: "Tim Hanlon", email: "tim@timhanlon.com" },
      committedAt: "2026-06-17T01:00:00+10:00",
      files: ["src/a.ts", "src/b.ts"],
    })
  })

  it("treats a detached-HEAD null branch as no branch in the note", () => {
    const commit = commitFromSignal(signalFrom({ hookInput: { branch: null } }))!
    expect(commit.branch).toBeNull()
    expect(commitCitationNote(commit)).toBe("fix(ids): drop shortId")
  })

  it("prefixes the note with the branch when present", () => {
    expect(commitCitationNote(commitFromSignal(signalFrom())!)).toBe("dev: fix(ids): drop shortId")
  })
})

describe("pickWorkForCommit (which work a commit lands on)", () => {
  const open = (id: string, updatedAt: string, status: WorkStatus = "open") =>
    workRow({ id: arcId("work", id), status, updatedAt })

  it("returns null when the chat has no work", () => {
    expect(pickWorkForCommit([])).toBeNull()
  })

  it("prefers the most-recently-updated open work", () => {
    const picked = pickWorkForCommit([
      open("work_old", "2026-06-17T01:00:00.000Z"),
      open("work_new", "2026-06-17T03:00:00.000Z"),
      open("work_mid", "2026-06-17T02:00:00.000Z"),
    ])
    expect(picked?.id).toBe("work_new")
  })

  it("skips resolved work in favor of an older open item", () => {
    const picked = pickWorkForCommit([
      open("work_done", "2026-06-17T05:00:00.000Z", "done"),
      open("work_open", "2026-06-17T02:00:00.000Z", "active"),
    ])
    expect(picked?.id).toBe("work_open")
  })

  it("falls back to the most-recent work of any status when none are open", () => {
    const picked = pickWorkForCommit([
      open("work_a", "2026-06-17T01:00:00.000Z", "done"),
      open("work_b", "2026-06-17T04:00:00.000Z", "superseded"),
    ])
    expect(picked?.id).toBe("work_b")
  })
})
