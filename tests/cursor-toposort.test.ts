import { describe, expect, it } from "vitest"
import { type CursorBlob, topologicalSort } from "../src/main/ingest/providers/cursor.js"

const blob = (id: string, refs: ReadonlyArray<string>, rowid = 0): CursorBlob => ({
  rowid,
  id,
  json: "",
  refs,
})

const ids = (blobs: ReadonlyArray<CursorBlob>) => blobs.map((b) => b.id)

describe("cursor topologicalSort", () => {
  it("emits post-order, refs in array order, each blob once — with a diamond, an unknown ref, and an orphan", () => {
    // A -> [B, C]; B -> [D]; C -> [D] (diamond); D -> [Z] (Z unknown); O unreachable.
    const blobs = [
      blob("A", ["B", "C"]),
      blob("B", ["D"]),
      blob("C", ["D"]),
      blob("D", ["Z"]),
      blob("O", []),
    ]

    const { sorted, orphaned } = topologicalSort(blobs, "A")

    // Post-order from A: dependencies precede dependents; the diamond's shared D
    // is emitted once, on first visit.
    expect(ids(sorted)).toEqual(["D", "B", "C", "A"])
    expect(ids(orphaned)).toEqual(["O"])
  })

  it("terminates on a cycle, emitting each blob once", () => {
    const blobs = [blob("A", ["B"]), blob("B", ["A"])]
    const { sorted, orphaned } = topologicalSort(blobs, "A")
    expect(ids(sorted)).toEqual(["B", "A"])
    expect(orphaned).toHaveLength(0)
  })

  it("handles a deep linear chain without a stack overflow", () => {
    const n = 200_000
    const blobs = Array.from({ length: n }, (_, i) =>
      blob(String(i), i === 0 ? [] : [String(i - 1)], i),
    )

    const { sorted, orphaned } = topologicalSort(blobs, String(n - 1))

    expect(sorted).toHaveLength(n)
    // Post-order: the chain root (0) is emitted first, the end blob last.
    expect(sorted[0]?.id).toBe("0")
    expect(sorted[n - 1]?.id).toBe(String(n - 1))
    expect(orphaned).toHaveLength(0)
  })
})
