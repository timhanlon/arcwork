import { describe, expect, it } from "vitest"
import { parseRecap } from "../src/shared/recap.js"

describe("parseRecap", () => {
  it("splits a Goal:/Next: recap and strips the disable-recaps hint", () => {
    const recap = parseRecap(
      "Goal: extract token-usage data in arc-ingest. I wrote docs/token-usage-metadata.md. " +
        "Next: you pick a storage shape so I can wire up extraction. (disable recaps in /config)",
    )
    expect(recap.goal).toBe(
      "extract token-usage data in arc-ingest. I wrote docs/token-usage-metadata.md.",
    )
    expect(recap.next).toBe("you pick a storage shape so I can wire up extraction.")
    expect(recap.body).not.toContain("disable recaps")
  })

  it("handles a recap that omits the Goal: label but keeps Next:", () => {
    const recap = parseRecap("Goal was to extract usage data. Next: decide the storage shape.")
    expect(recap.goal).toBe("Goal was to extract usage data.")
    expect(recap.next).toBe("decide the storage shape.")
  })

  it("falls back to opaque body when neither marker is present", () => {
    const recap = parseRecap("You committed two arc-prototype changes and pushed them.")
    // No Goal: label and no Next: clause — goal/next stay null so the card
    // renders the raw body instead of mislabelling it under "Where you left off".
    expect(recap.goal).toBeNull()
    expect(recap.next).toBeNull()
    expect(recap.body).toBe("You committed two arc-prototype changes and pushed them.")
  })

  it("treats a Goal:-only recap as goal with no next step", () => {
    const recap = parseRecap("Goal: ship the recap card.")
    expect(recap.goal).toBe("ship the recap card.")
    expect(recap.next).toBeNull()
  })
})
