import { Result } from "effect"
import { describe, expect, it } from "vitest"
import type { TargetSession } from "../src/shared/instance.js"
import { deriveActivity } from "../src/main/services/LiveTargetStateService.js"
import { isTurnEnd, isTurnStart, turnLifecycle } from "../src/main/hooks/turn-lifecycle.js"
import { toSignal } from "../src/main/hooks/signals.js"
import type { HookSignal } from "../src/main/hooks/signals.js"
import { arcId } from "../src/shared/ids.js"

const session = (over: Partial<TargetSession>): TargetSession => ({
  _tag: "TargetSession",
  id: arcId("target", "target_1"),
  provider: "claude",
  chatId: arcId("chat", "chat_1"),
  cwd: "/tmp/repo",
  attached: true,
  state: "running",
  startedAt: "2026-06-12T00:00:00.000Z",
  ...over,
})

const signal = (declaredEvent: string): HookSignal =>
  Result.getOrThrow(
    toSignal(
      JSON.stringify({ declaredProvider: "claude", declaredEvent, observedAt: "2026-06-12T00:00:00.000Z" }),
    ),
  )

describe("deriveActivity", () => {
  const noTurns = new Set<string>()
  const open = new Set<string>(["target_1"])

  it("reports exited from the persisted lifecycle state, ignoring stale turn/pending", () => {
    expect(deriveActivity(session({ state: "exited" }), "permission", open)).toBe("exited")
  })

  it("reports detached when this process holds no PTY, even mid-turn", () => {
    expect(deriveActivity(session({ attached: false }), undefined, open)).toBe("detached")
  })

  it("an exited+detached child is exited (lifecycle wins over PTY ownership)", () => {
    expect(deriveActivity(session({ attached: false, state: "exited" }), undefined, open)).toBe("exited")
  })

  it("attention beats an open turn — approval outranks input", () => {
    expect(deriveActivity(session({}), "permission", open)).toBe("waiting_for_approval")
    expect(deriveActivity(session({}), "question", open)).toBe("waiting_for_input")
  })

  it("an open turn with nothing pending is generating", () => {
    expect(deriveActivity(session({}), undefined, open)).toBe("generating")
  })

  it("attached with no open turn and nothing pending is idle — not merely 'running'", () => {
    expect(deriveActivity(session({ state: "running" }), undefined, noTurns)).toBe("idle")
  })

  it("a question still pending after the turn closes stays waiting_for_input", () => {
    expect(deriveActivity(session({}), "question", noTurns)).toBe("waiting_for_input")
  })
})

describe("turnLifecycle", () => {
  it("opens on a prompt submit (Claude/Codex UserPromptSubmit, Cursor beforeSubmitPrompt)", () => {
    expect(isTurnStart(signal("UserPromptSubmit"))).toBe(true)
    expect(turnLifecycle(signal("UserPromptSubmit"))).toBe("open")
    expect(turnLifecycle(signal("beforeSubmitPrompt"))).toBe("open")
  })

  it("closes on Stop and on session end", () => {
    expect(isTurnEnd(signal("Stop"))).toBe(true)
    expect(turnLifecycle(signal("Stop"))).toBe("close")
    expect(turnLifecycle(signal("SessionEnd"))).toBe("close")
  })

  it("a SubagentStop does not end the parent turn", () => {
    expect(isTurnEnd(signal("SubagentStop"))).toBe(false)
    expect(turnLifecycle(signal("SubagentStop"))).toBe(null)
  })

  it("mid-turn tool events carry no transition", () => {
    expect(turnLifecycle(signal("PreToolUse"))).toBe(null)
    expect(turnLifecycle(signal("PostToolUse"))).toBe(null)
  })
})
