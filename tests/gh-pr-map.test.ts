import { describe, expect, it } from "vitest"
import { summarizeChecks, type GhPullRequest } from "../src/main/services/git/parse.js"
import { mapGhPullRequest } from "../src/main/services/git/wire.js"

describe("summarizeChecks", () => {
  it("returns null when there are no checks", () => {
    expect(summarizeChecks(null)).toBeNull()
    expect(summarizeChecks([])).toBeNull()
  })

  it("is failing when any CheckRun concluded in failure", () => {
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "COMPLETED", conclusion: "FAILURE" },
      ]),
    ).toBe("failing")
  })

  it("is pending when a check is still running and none failed", () => {
    expect(
      summarizeChecks([
        { status: "COMPLETED", conclusion: "SUCCESS" },
        { status: "IN_PROGRESS", conclusion: null },
      ]),
    ).toBe("pending")
  })

  it("is passing when every check succeeded", () => {
    expect(summarizeChecks([{ status: "COMPLETED", conclusion: "SUCCESS" }])).toBe("passing")
  })

  it("handles legacy StatusContext entries (state, no conclusion)", () => {
    expect(summarizeChecks([{ state: "SUCCESS" }, { state: "PENDING" }])).toBe("pending")
    expect(summarizeChecks([{ state: "ERROR" }])).toBe("failing")
  })
})

describe("mapGhPullRequest", () => {
  const now = "2026-06-19T12:00:00.000Z"

  it("normalizes gh's uppercase enums and nested author into the row", () => {
    const raw: GhPullRequest = {
      number: 42,
      id: "PR_node",
      title: "Add worktrees",
      body: "body text",
      state: "OPEN",
      isDraft: false,
      author: { login: "octocat" },
      headRefName: "feature/worktrees",
      headRefOid: "abc123",
      baseRefName: "main",
      reviewDecision: "APPROVED",
      mergeable: "MERGEABLE",
      mergeStateStatus: "CLEAN",
      url: "https://github.com/acme/widgets/pull/42",
      statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }],
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    }

    expect(mapGhPullRequest("repo_x", "pr_x", raw, now)).toEqual({
      id: "pr_x",
      repositoryId: "repo_x",
      number: 42,
      githubNodeId: "PR_node",
      title: "Add worktrees",
      body: "body text",
      state: "open",
      isDraft: 0,
      author: "octocat",
      headRef: "feature/worktrees",
      headSha: "abc123",
      headRepositoryOwner: null,
      headRepositoryName: null,
      baseRef: "main",
      reviewState: "approved",
      checksState: "passing",
      mergeable: "mergeable",
      mergeStateStatus: "clean",
      url: "https://github.com/acme/widgets/pull/42",
      lastSyncedAt: now,
      createdAt: "2026-06-18T00:00:00.000Z",
      updatedAt: "2026-06-19T00:00:00.000Z",
    })
  })

  it("blanks UNKNOWN mergeable/state and an empty review decision to null", () => {
    const raw: GhPullRequest = {
      number: 7,
      state: "MERGED",
      isDraft: true,
      reviewDecision: "",
      mergeable: "UNKNOWN",
      mergeStateStatus: "UNKNOWN",
      headRefName: "fix",
      baseRefName: "main",
    }
    const row = mapGhPullRequest("repo_x", "pr_y", raw, now)
    expect(row.state).toBe("merged")
    expect(row.isDraft).toBe(1)
    expect(row.reviewState).toBeNull()
    expect(row.mergeable).toBeNull()
    expect(row.mergeStateStatus).toBeNull()
    expect(row.checksState).toBeNull()
    // Missing timestamps fall back to the sync instant.
    expect(row.createdAt).toBe(now)
    expect(row.author).toBeNull()
  })
})
