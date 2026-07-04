import { describe, expect, it } from "vitest"
import { parseDecisionPayload, projectApprovals } from "../src/main/services/codex-approval-view.js"
import type { SessionApprovals } from "../src/main/services/CodexDriverRegistry.js"

const sessions: ReadonlyArray<SessionApprovals> = [
  {
    chatId: "chat_1",
    targetSessionId: "target_1",
    approvals: [
      {
        id: 501,
        approvalId: "appr_1",
        itemId: "call_1",
        command: "printf hi > f",
        // A string decision and an object (rule-carrying) decision.
        availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["x"] } }, "cancel"],
      },
    ],
  },
  {
    chatId: "chat_2",
    targetSessionId: "target_2",
    approvals: [{ id: "req-9", approvalId: null, itemId: "call_2", command: null, availableDecisions: ["accept"] }],
  },
]

describe("codex approval projection", () => {
  it("flattens sessions and normalizes decisions to label + verbatim payload", () => {
    const view = projectApprovals(sessions)
    expect(view).toHaveLength(2)

    const first = view.find((a) => a.requestId === 501)!
    expect(first.chatId).toBe("chat_1")
    expect(first.targetSessionId).toBe("target_1")
    expect(first.approvalId).toBe("appr_1")
    expect(first.itemId).toBe("call_1")
    expect(first.decisions.map((d) => d.label)).toEqual(["accept", "acceptWithExecpolicyAmendment", "cancel"])
    // Object decision's payload preserves the rule verbatim.
    expect(JSON.parse(first.decisions[1]!.payload)).toEqual({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["x"] },
    })

    const second = view.find((a) => a.requestId === "req-9")!
    expect(second.approvalId).toBeNull()
    expect(second.command).toBeNull()
  })

  it("round-trips a decision payload back to its raw value", () => {
    const view = projectApprovals(sessions)
    const amend = view[0]!.decisions[1]!
    // The renderer echoes payload back; the driver receives the exact object.
    expect(parseDecisionPayload(amend.payload)).toEqual({
      acceptWithExecpolicyAmendment: { execpolicy_amendment: ["x"] },
    })
    expect(parseDecisionPayload('"accept"')).toBe("accept")
    // A malformed payload degrades to the literal string, never throws.
    expect(parseDecisionPayload("not json")).toBe("not json")
  })
})
