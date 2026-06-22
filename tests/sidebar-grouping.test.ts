import { describe, expect, it } from "vitest"
import { groupByProject, type WorkspaceGroup } from "../src/renderer/src/sidebar/grouping.js"
import type { Workspace } from "../src/shared/workspace.js"
import { arcId } from "../src/shared/ids.js"

const ws = (over: Partial<Omit<Workspace, "id">> & { readonly id: string }): Workspace => ({
  path: `/dev/${over.id}`,
  name: over.id,
  repositoryId: null,
  repoLabel: null,
  defaultBranch: null,
  branch: null,
  isWorktree: false,
  pullRequest: null,
  ...over,
  id: arcId("workspace", over.id),
})

const group = (workspace: Workspace): WorkspaceGroup => ({
  workspace,
  chats: [],
  sessionsByChat: new Map(),
})

describe("groupByProject", () => {
  it("collects a repo's main checkout and worktrees under one project, main first", () => {
    const groups = [
      group(ws({ id: "feat", path: "/wt/feat", repositoryId: "repo_1", repoLabel: "acme/arc", branch: "feat/git", isWorktree: true })),
      group(ws({ id: "main", path: "/dev/arc", repositoryId: "repo_1", repoLabel: "acme/arc", defaultBranch: "main", branch: "main" })),
      group(ws({ id: "spike", path: "/wt/spike", repositoryId: "repo_1", repoLabel: "acme/arc", branch: "spike", isWorktree: true })),
    ]
    const projects = groupByProject(groups)
    expect(projects).toHaveLength(1)
    expect(projects[0]!.repositoryId).toBe("repo_1")
    expect(projects[0]!.label).toBe("acme/arc")
    expect(projects[0]!.members.map((m): string => m.workspace.id)).toEqual(["main", "feat", "spike"])
  })

  it("still gives a single-workspace repo its own project (header always shows)", () => {
    const projects = groupByProject([
      group(ws({ id: "solo", repositoryId: "repo_2", repoLabel: "acme/solo", branch: "main" })),
    ])
    expect(projects).toHaveLength(1)
    expect(projects[0]!.repositoryId).toBe("repo_2")
    expect(projects[0]!.members).toHaveLength(1)
  })

  it("keeps a plain folder top-level and ungrouped (no fake project header)", () => {
    const projects = groupByProject([group(ws({ id: "notes", name: "notes" }))])
    expect(projects).toHaveLength(1)
    expect(projects[0]!.repositoryId).toBeNull()
    expect(projects[0]!.label).toBe("notes")
  })

  it("preserves first-appearance order across repos and plain folders", () => {
    const projects = groupByProject([
      group(ws({ id: "notes", name: "notes" })),
      group(ws({ id: "arc-main", repositoryId: "repo_1", repoLabel: "acme/arc", branch: "main" })),
      group(ws({ id: "arc-feat", repositoryId: "repo_1", repoLabel: "acme/arc", branch: "feat", isWorktree: true })),
    ])
    expect(projects.map((p) => p.key)).toEqual(["notes", "repo_1"])
    expect(projects[1]!.members).toHaveLength(2)
  })
})
