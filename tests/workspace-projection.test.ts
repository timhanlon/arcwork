import { describe, expect, it } from "vitest"
import { rowToWorkspace } from "../src/main/services/WorkspaceService.js"
import type { RepositoryRow, WorkspaceRow } from "../src/main/db/schema.js"

const repo = (over: Partial<RepositoryRow> & Pick<RepositoryRow, "id" | "rootPath">): RepositoryRow => ({
  commonGitDir: `${over.rootPath}/.git`,
  defaultBranch: "main",
  remotesJson: "[]",
  githubOwner: null,
  githubRepo: null,
  githubNodeId: null,
  createdAt: "2026-01-01T00:00:00Z",
  lastSeenAt: "2026-01-01T00:00:00Z",
  ...over,
})

const wsRow = (over: Partial<WorkspaceRow> & Pick<WorkspaceRow, "id" | "path">): WorkspaceRow => ({
  name: "ws",
  createdAt: "2026-01-01T00:00:00Z",
  lastOpenedAt: "2026-01-01T00:00:00Z",
  repositoryId: null,
  worktreeId: null,
  gitBranch: null,
  gitHeadSha: null,
  ...over,
})

describe("rowToWorkspace", () => {
  it("labels a GitHub-backed repo as owner/repo and marks the root as the main checkout", () => {
    const repos = new Map([
      ["repo_1", repo({ id: "repo_1", rootPath: "/dev/arc", githubOwner: "acme", githubRepo: "arc" })],
    ])
    const ws = rowToWorkspace(
      wsRow({ id: "ws_1", path: "/dev/arc", repositoryId: "repo_1", gitBranch: "main" }),
      repos,
    )
    expect(ws.repoLabel).toBe("acme/arc")
    expect(ws.defaultBranch).toBe("main")
    expect(ws.branch).toBe("main")
    expect(ws.isWorktree).toBe(false)
  })

  it("falls back to the repo root basename without a GitHub identity", () => {
    const repos = new Map([["repo_1", repo({ id: "repo_1", rootPath: "/dev/arc" })]])
    const ws = rowToWorkspace(wsRow({ id: "ws_1", path: "/dev/arc", repositoryId: "repo_1" }), repos)
    expect(ws.repoLabel).toBe("arc")
  })

  it("marks a workspace below the repo root as a worktree", () => {
    const repos = new Map([["repo_1", repo({ id: "repo_1", rootPath: "/dev/arc" })]])
    const ws = rowToWorkspace(
      wsRow({ id: "ws_2", path: "/wt/arc-feat", repositoryId: "repo_1", gitBranch: "feat/git" }),
      repos,
    )
    expect(ws.isWorktree).toBe(true)
    expect(ws.branch).toBe("feat/git")
  })

  it("leaves a plain (non-git) folder ungrouped", () => {
    const ws = rowToWorkspace(wsRow({ id: "ws_3", path: "/notes" }), new Map())
    expect(ws.repositoryId).toBeNull()
    expect(ws.repoLabel).toBeNull()
    expect(ws.isWorktree).toBe(false)
  })
})
