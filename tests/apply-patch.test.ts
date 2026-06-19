import { describe, expect, it } from "vitest"
import { parseApplyPatchEdits } from "../src/renderer/src/chat/tool-calls/apply-patch.js"

// Codex `apply_patch` bodies wrap one or more per-file edits in a
// `*** Begin Patch … *** End Patch` envelope. The renderer turns each into a
// before/after pair the diff component draws. Pure string logic; see apply-patch.ts.

describe("parseApplyPatchEdits", () => {
  it("parses an Update File hunk into a before/after pair", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: src/a.ts",
      "@@",
      " const keep = 1",
      "-const old = 2",
      "+const next = 3",
      "*** End Patch",
    ].join("\n")
    expect(parseApplyPatchEdits(patch)).toEqual([
      { path: "src/a.ts", oldStr: "const keep = 1\nconst old = 2", newStr: "const keep = 1\nconst next = 3" },
    ])
  })

  it("parses an Add File as all-new content with an empty before", () => {
    const patch = ["*** Begin Patch", "*** Add File: new.ts", "+line one", "+line two", "*** End Patch"].join("\n")
    expect(parseApplyPatchEdits(patch)).toEqual([{ path: "new.ts", oldStr: "", newStr: "line one\nline two" }])
  })

  it("parses a Delete File as removed content with an empty after", () => {
    const patch = ["*** Begin Patch", "*** Delete File: gone.ts", "-was here", "*** End Patch"].join("\n")
    expect(parseApplyPatchEdits(patch)).toEqual([{ path: "gone.ts", oldStr: "was here", newStr: "" }])
  })

  it("splits a multi-file patch into one edit per file", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: a.ts",
      "-a old",
      "+a new",
      "*** Update File: b.ts",
      "-b old",
      "+b new",
      "*** End Patch",
    ].join("\n")
    const edits = parseApplyPatchEdits(patch)
    expect(edits.map((e) => e.path)).toEqual(["a.ts", "b.ts"])
  })

  it("treats a Move to: as a rename, attributing new content to the moved path", () => {
    const patch = [
      "*** Begin Patch",
      "*** Update File: old/path.ts",
      "*** Move to: new/path.ts",
      "+moved content",
      "*** End Patch",
    ].join("\n")
    const edits = parseApplyPatchEdits(patch)
    expect(edits.at(-1)?.path).toBe("new/path.ts")
    expect(edits.at(-1)?.newStr).toBe("moved content")
  })

  it("returns no edits for a body with no file headers", () => {
    expect(parseApplyPatchEdits("*** Begin Patch\n*** End Patch")).toEqual([])
  })
})
