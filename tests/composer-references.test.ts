import { describe, expect, it } from "vitest"
import {
  type ReferenceCandidate,
  applyReference,
  detectMention,
  filterCandidates,
  fuzzyScore,
  removeMention,
} from "../src/renderer/src/chat/composer/references.js"

const AT = "@"

const cand = (
  kind: ReferenceCandidate["kind"],
  label: string,
  insertText: string,
): ReferenceCandidate => ({ kind, key: `${kind}:${insertText}`, label, insertText })

describe("detectMention", () => {
  it("fires for a trigger at the start of the text", () => {
    expect(detectMention("@key", 4, AT)).toEqual({ start: 0, query: "key" })
  })

  it("fires for a trigger after whitespace and captures the query up to the caret", () => {
    // caret sits after "ke" — the query is what's been typed so far, not the whole word
    expect(detectMention("see @keyb", 7, AT)).toEqual({ start: 4, query: "ke" })
  })

  it("does not fire mid-word, so emails like a@b are left alone", () => {
    expect(detectMention("mail a@b", 8, AT)).toBeNull()
  })

  it("returns null once whitespace separates the caret from the trigger", () => {
    expect(detectMention("@key done", 9, AT)).toBeNull()
  })

  it("treats an empty query (bare trigger) as an active mention", () => {
    expect(detectMention("hi @", 4, AT)).toEqual({ start: 3, query: "" })
  })

  it("anchors to the nearest trigger when several are present", () => {
    expect(detectMention("@a @b", 5, AT)).toEqual({ start: 3, query: "b" })
  })
})

describe("applyReference", () => {
  it("splices the selected value in for the query without keeping the trigger", () => {
    const mention = { start: 4, query: "ke" }
    const out = applyReference("see @ke", mention, cand("file", "k.ts", "src/k.ts"), AT)
    expect(out.value).toBe("see src/k.ts ")
    expect(out.caret).toBe(out.value.length)
  })

  it("preserves text after the mention and lands the caret right after the token", () => {
    const mention = { start: 0, query: "w" }
    const out = applyReference("@w tail", mention, cand("work", "Fix", "work_1"), AT)
    expect(out.value).toBe("work_1  tail")
    expect(out.value.slice(out.caret)).toBe(" tail")
  })
})

describe("removeMention", () => {
  it("deletes the query and inserts nothing, leaving surrounding text intact", () => {
    const mention = { start: 8, query: "cod" }
    const out = removeMention("look at @cod", mention, AT)
    expect(out.value).toBe("look at ")
    expect(out.caret).toBe("look at ".length)
  })

  it("keeps a previously-inserted reference when a later mention is removed", () => {
    const text = "see src/k.ts @cod"
    const mention = { start: 13, query: "cod" }
    expect(removeMention(text, mention, AT).value).toBe("see src/k.ts ")
  })
})

describe("fuzzyScore", () => {
  it("scores an empty query as a neutral match", () => {
    expect(fuzzyScore("", "anything")).toBe(0)
  })

  it("returns -1 when the query is not a subsequence", () => {
    expect(fuzzyScore("xyz", "keybindings")).toBe(-1)
  })

  it("ranks a contiguous run above a scattered match", () => {
    expect(fuzzyScore("chat", "chatpane")).toBeGreaterThan(fuzzyScore("chat", "c_h_a_t_zzzz"))
  })

  it("rewards a match at the start", () => {
    expect(fuzzyScore("key", "keybindings")).toBeGreaterThan(fuzzyScore("key", "the-key"))
  })
})

describe("filterCandidates", () => {
  const candidates: ReadonlyArray<ReferenceCandidate> = [
    cand("work", "Fix the race", "work_1"),
    cand("file", "ChatComposer.tsx", "src/renderer/composer/ChatComposer.tsx"),
    cand("file", "keybindings.ts", "src/renderer/shell/keybindings.ts"),
    cand("session", "claude", "target_1"),
  ]

  it("returns everything (capped) for an empty query", () => {
    expect(filterCandidates(candidates, "")).toHaveLength(candidates.length)
    expect(filterCandidates(candidates, "", 2)).toHaveLength(2)
  })

  it("matches files on their full path, not just the basename", () => {
    const out = filterCandidates(candidates, "shell")
    expect(out.map((c) => c.label)).toEqual(["keybindings.ts"])
  })

  it("drops non-matches, keeping only fuzzy hits", () => {
    // "cha" is a subsequence of ChatComposer but not of "claude" (no 'h') or the
    // work title, so only the one file survives.
    expect(filterCandidates(candidates, "cha").map((c) => c.label)).toEqual(["ChatComposer.tsx"])
  })
})
