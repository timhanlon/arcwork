import { describe, expect, it } from "vitest"
import { filterByTitle } from "../src/renderer/src/shell/commandPaletteModel.js"

const items = [
  { title: "New chat" },
  { title: "New work item" },
  { title: "Show git" },
  { title: "Toggle left panel" },
]

describe("filterByTitle", () => {
  it("returns the list unchanged for an empty or whitespace query", () => {
    expect(filterByTitle(items, "")).toEqual(items)
    expect(filterByTitle(items, "   ")).toEqual(items)
  })

  it("matches case-insensitive substrings and preserves declaration order", () => {
    expect(filterByTitle(items, "NEW").map((i) => i.title)).toEqual(["New chat", "New work item"])
    expect(filterByTitle(items, "git").map((i) => i.title)).toEqual(["Show git"])
  })

  it("returns empty when nothing matches", () => {
    expect(filterByTitle(items, "deploy")).toEqual([])
  })
})
