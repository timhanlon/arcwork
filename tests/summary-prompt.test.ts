import { describe, expect, it } from "vitest"
import { buildDistillPrompt, PROMPT_VERSION } from "../src/main/summary/prompt.js"

describe("buildDistillPrompt", () => {
  it("wraps the timeline in START/END markers with instructions AFTER the transcript", () => {
    const prompt = buildDistillPrompt("USER: hello")
    expect(prompt.startsWith("SESSION TIMELINE START\nUSER: hello\nSESSION TIMELINE END\n\n")).toBe(true)
    // Instruction placement is load-bearing: the ask must land after the transcript.
    const endIdx = prompt.indexOf("SESSION TIMELINE END")
    const askIdx = prompt.indexOf("compaction summary")
    expect(askIdx).toBeGreaterThan(endIdx)
  })

  it("emits the seven required markdown sections", () => {
    const prompt = buildDistillPrompt("")
    for (const section of [
      "## Primary Request and Intent",
      "## Key Technical Concepts",
      "## Files and Code Sections",
      "## Errors and Fixes",
      "## User Preferences and Feedback",
      "## Current State",
      "## Remaining Work",
    ]) {
      expect(prompt).toContain(section)
    }
  })

  it("pins a prompt version so a reworded prompt distills afresh", () => {
    expect(PROMPT_VERSION).toBe(1)
  })
})
