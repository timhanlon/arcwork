import { describe, expect, it } from "vitest"
import { renderTimeline, type TimelineRow } from "../src/main/summary/render-timeline.js"

// The renderer is pure: fixture rows in, deterministic condensed text out. These
// cover the per-role caps, the skip rules, tool-body parsing, and — the load-
// bearing case — never splitting an arc id or file path mid-token.

const toolBody = (name: string, input: string, output: string): string =>
  [`[Tool: ${name}]`, "State: output-available", "Input:", input, "Output:", output].join("\n")

describe("renderTimeline", () => {
  it("labels user/assistant/subagent/tool rows and skips recap/meta/request", () => {
    const rows: ReadonlyArray<TimelineRow> = [
      { role: "user", body: "do the thing" },
      { role: "assistant", body: "on it" },
      { role: "subagent", body: "sub result" },
      { role: "tool", body: toolBody("Bash", '{"command":"ls"}', "a\nb") },
      { role: "recap", body: "away summary — must not appear" },
      { role: "meta", body: "meta noise" },
      { role: "request", body: "[Question] pick one" },
    ]
    const out = renderTimeline(rows)
    expect(out).toContain("USER: do the thing")
    expect(out).toContain("ASSISTANT: on it")
    expect(out).toContain("SUBAGENT: sub result")
    expect(out).toContain("TOOL Bash")
    expect(out).not.toContain("away summary")
    expect(out).not.toContain("meta noise")
    expect(out).not.toContain("[Question]")
  })

  it("skips local-command noise and Caveat-prefixed user rows", () => {
    const rows: ReadonlyArray<TimelineRow> = [
      { role: "user", body: "<local-command-stdout>done</local-command-stdout>" },
      { role: "user", body: "Caveat: the messages below were generated..." },
      { role: "user", body: "real prompt" },
    ]
    const out = renderTimeline(rows)
    expect(out).toBe("USER: real prompt")
  })

  it("collapses a tool row to one line: name + truncated input + output", () => {
    const out = renderTimeline([{ role: "tool", body: toolBody("Grep", '{"pattern":"foo"}', "3 matches") }])
    expect(out).toBe('TOOL Grep({"pattern":"foo"}) => 3 matches')
  })

  it("caps assistant bodies near 900 chars", () => {
    const long = "x".repeat(4000)
    const out = renderTimeline([{ role: "assistant", body: long }])
    // "ASSISTANT: " prefix + ~900 body + an ellipsis; far below the raw length.
    expect(out.length).toBeLessThan(1000)
    expect(out.endsWith("…")).toBe(true)
  })

  it("never truncates an arc id mid-token — extends the cut to preserve it", () => {
    // Put a work id so its start sits before the tool-input cap (120) but its end
    // sits after it: a naive slice would split the base32 suffix.
    const id = "work_01kwt7wgyee00td3yyjf8r8099"
    const filler = "y".repeat(110)
    const input = `${filler} ${id} trailing`
    const out = renderTimeline([{ role: "tool", body: toolBody("Bash", input, "") }])
    expect(out).toContain(id)
    // The whole, unbroken id is present (not a prefix of it).
    expect(out).toMatch(new RegExp(`${id}\\b`))
  })

  it("appends ids/paths that fall entirely into the dropped tail as refs", () => {
    const lostId = "chat_01kwt7wgyee00td3yyjf8r8099"
    const lostPath = "src/main/summary/distiller.ts"
    const input = `${"z".repeat(200)} ${lostId} then ${lostPath}`
    const out = renderTimeline([{ role: "tool", body: toolBody("Bash", input, "") }])
    expect(out).toContain(lostId)
    expect(out).toContain(lostPath)
    expect(out).toContain("[refs:")
  })

  it("degrades gracefully under a char budget by tightening caps, not dropping turns", () => {
    const rows: ReadonlyArray<TimelineRow> = Array.from({ length: 20 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      body: `${i % 2 === 0 ? "prompt" : "reply"} ${i} ${"w".repeat(1500)}`,
    }))
    const unbounded = renderTimeline(rows)
    const bounded = renderTimeline(rows, { charBudget: 4000 })
    expect(bounded.length).toBeLessThan(unbounded.length)
    // Every turn still present (head and tail preserved), just shorter.
    expect(bounded.split("\n")).toHaveLength(20)
    expect(bounded).toContain("USER: prompt 0")
    expect(bounded).toContain("ASSISTANT: reply 19")
  })

  it("is deterministic for identical input", () => {
    const rows: ReadonlyArray<TimelineRow> = [
      { role: "user", body: "hi" },
      { role: "tool", body: toolBody("Bash", '{"command":"echo hi"}', "hi") },
    ]
    expect(renderTimeline(rows)).toBe(renderTimeline(rows))
  })
})
