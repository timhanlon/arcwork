import { describe, expect, it } from "vitest"
import { isArcBlock, isArcCommand, replaceArcBlock } from "../src/main/hooks/install.js"

// The merge's whole job after relocating the helper: re-installing must *replace*
// Arc's own hook block (matched by the helper filename, regardless of the path in
// front of it) rather than append. The old append-only merge left a stale block
// pointing at the gone repo-local helper, firing forever alongside the new one.

const OLD = `node "/work/repo/.arc/runtime/arc-hook-signal.mjs" claude PreToolUse`
const NEW = `node "/Users/me/.arcwork/dev/runtime/arc-hook-signal.mjs" claude PreToolUse`
const claudeBlock = (command: string) => ({ matcher: "", hooks: [{ type: "command", command }] })

describe("isArcCommand", () => {
  it("matches `node <helper> …` across path changes and quoting", () => {
    expect(isArcCommand(OLD)).toBe(true) // old repo-local path
    expect(isArcCommand(NEW)).toBe(true) // new Arc-owned path
    expect(isArcCommand(`node /bare/path/arc-hook-signal.mjs codex Stop`)).toBe(true)
  })

  it("does NOT match a user command that merely mentions the helper filename", () => {
    expect(isArcCommand("./scripts/log.sh arc-hook-signal.mjs")).toBe(false) // not `node`
    expect(isArcCommand("cat notes-arc-hook-signal.mjs.txt")).toBe(false)
    expect(isArcCommand(`node ./mine.mjs # logs to arc-hook-signal.mjs`)).toBe(false) // script is mine.mjs
    expect(isArcCommand("npm run lint")).toBe(false)
  })
})

describe("isArcBlock", () => {
  it("matches Arc's helper by command shape across both nestings and paths", () => {
    expect(isArcBlock(claudeBlock(OLD))).toBe(true) // old repo-local path
    expect(isArcBlock(claudeBlock(NEW))).toBe(true) // new Arc-owned path
    expect(isArcBlock({ command: NEW })).toBe(true) // cursor-shaped (top-level command)
  })

  it("leaves user-authored blocks alone", () => {
    expect(isArcBlock({ command: "npm run lint" })).toBe(false)
    expect(isArcBlock(claudeBlock("./scripts/notify.sh"))).toBe(false)
    expect(isArcBlock({ command: "cat arc-hook-signal.mjs" })).toBe(false) // mentions, not invokes
    expect(isArcBlock(null)).toBe(false)
  })
})

describe("replaceArcBlock", () => {
  it("evicts the stale Arc block and installs exactly one fresh one", () => {
    const next = replaceArcBlock([claudeBlock(OLD)], claudeBlock(NEW))
    const arc = next.filter(isArcBlock)
    expect(arc).toHaveLength(1)
    expect(JSON.stringify(arc[0])).toContain(".arcwork/dev/runtime")
    expect(JSON.stringify(arc[0])).not.toContain("/.arc/runtime/")
  })

  it("preserves a user block sitting alongside Arc's", () => {
    const user = claudeBlock("./scripts/notify.sh")
    const next = replaceArcBlock([user, claudeBlock(OLD)], claudeBlock(NEW))
    expect(next.filter((b) => !isArcBlock(b))).toEqual([user])
    expect(next.filter(isArcBlock)).toHaveLength(1)
  })

  it("installs cleanly when there is no existing config", () => {
    expect(replaceArcBlock(undefined, claudeBlock(NEW))).toEqual([claudeBlock(NEW)])
  })

  it("preserves a user command sharing a matcher block with Arc's (command-level prune)", () => {
    // A single Claude block carrying BOTH Arc's command and the user's own.
    const mixed = { matcher: "", hooks: [{ type: "command", command: OLD }, { type: "command", command: "./notify.sh" }] }
    const next = replaceArcBlock([mixed], claudeBlock(NEW))

    // The user's command survives — only Arc's stale command was stripped.
    const userHooks = next.flatMap((b) => (Array.isArray(b["hooks"]) ? b["hooks"] : []))
    expect(userHooks).toContainEqual({ type: "command", command: "./notify.sh" })
    expect(JSON.stringify(next)).not.toContain("/.arc/runtime/") // stale Arc path gone
    expect(next.filter(isArcBlock)).toHaveLength(1) // exactly one fresh Arc block
  })

  it("does not touch a user block whose command only mentions the filename", () => {
    const user = { command: "cat arc-hook-signal.mjs" }
    const next = replaceArcBlock([user], { command: NEW })
    expect(next).toContainEqual(user)
  })
})
