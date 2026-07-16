import { describe, expect, it } from "vitest"
import { moveProject, orderProjects } from "../src/renderer/src/sidebar/projectPreferences.js"
import type { ProjectGroup } from "../src/renderer/src/sidebar/grouping.js"

const project = (key: string): ProjectGroup => ({
  key,
  repositoryId: key,
  label: key,
  defaultBranch: null,
  members: [],
})

describe("sidebar project preferences", () => {
  it("keeps pinned projects first while respecting the saved order in each tier", () => {
    const projects = [project("a"), project("b"), project("c"), project("d")]
    expect(orderProjects(projects, { pinned: ["c", "a"], order: ["c", "d", "a", "b"] }).map((p) => p.key)).toEqual([
      "c",
      "a",
      "d",
      "b",
    ])
  })

  it("keeps new projects in their incoming order after ranked projects", () => {
    expect(orderProjects([project("a"), project("new"), project("b")], { pinned: [], order: ["b", "a"] }).map((p) => p.key)).toEqual([
      "b",
      "a",
      "new",
    ])
  })

  it("moves a project directly before the drop target", () => {
    expect(moveProject(["a", "b", "c"], "c", "b")).toEqual(["a", "c", "b"])
  })
})
