import { describe, expect, it } from "vitest"
import { arcId } from "../src/shared/ids.js"
import { parseInjectedMarker, withInjectedMarker } from "../src/shared/injected-message.js"

const sender = arcId("target", "target_aaaaaaaaaaaaaaaaaaaaaaaaaa")
const inbox = "inbox_aaaaaaaaaaaaaaaaaaaaaaaaaa"

describe("injected-message marker", () => {
  it("round-trips sender + inbox id + body for a single delivery", () => {
    const text = withInjectedMarker(sender, "codex", "the body\nwith two lines", inbox)
    const parsed = parseInjectedMarker(text)
    expect(parsed).toEqual({
      senderTargetSessionId: sender,
      targetMessageId: inbox,
      body: "the body\nwith two lines",
    })
  })

  it("omits the inbox breadcrumb for a batch (no msg= segment)", () => {
    const text = withInjectedMarker(sender, "claude", "first\n\nsecond")
    expect(text).not.toContain("msg=")
    const parsed = parseInjectedMarker(text)
    expect(parsed?.senderTargetSessionId).toBe(sender)
    expect(parsed?.targetMessageId).toBeNull()
    expect(parsed?.body).toBe("first\n\nsecond")
  })

  it("returns null for an ordinary (human) user turn", () => {
    expect(parseInjectedMarker("just a normal prompt")).toBeNull()
    // A look-alike a user typed but without a well-formed target id is not a marker.
    expect(parseInjectedMarker("📨 [arc:from=nope] x says:\n\nhi")).toBeNull()
  })

  it("strips only the leading header, preserving body that itself mentions arc", () => {
    const body = "see [arc:from=...] in the docs"
    const parsed = parseInjectedMarker(withInjectedMarker(sender, "pi", body, inbox))
    expect(parsed?.body).toBe(body)
  })
})
