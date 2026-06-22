import { describe, expect, it } from "vitest"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { defaultBranchRemote, githubIdentity, resolveBranchRange } from "../src/main/services/GitService.js"

describe("githubIdentity", () => {
  it("prefers origin and reports the resolving remote name", () => {
    expect(
      githubIdentity([
        { name: "upstream", url: "git@github.com:acme/widgets.git" },
        { name: "origin", url: "https://github.com/tim/widgets.git" },
      ]),
    ).toEqual({ owner: "tim", repo: "widgets", remote: "origin" })
  })

  it("resolves a GitHub remote whatever its name is", () => {
    expect(githubIdentity([{ name: "arcwork", url: "https://github.com/timhanlon/arcwork.git" }])).toEqual({
      owner: "timhanlon",
      repo: "arcwork",
      remote: "arcwork",
    })
  })

  it("is null when no remote points at GitHub", () => {
    expect(githubIdentity([{ name: "origin", url: "git@gitlab.com:tim/x.git" }])).toBeNull()
    expect(githubIdentity([])).toBeNull()
  })
})

describe("defaultBranchRemote", () => {
  const remotes = [
    { name: "arcwork", url: "https://github.com/timhanlon/arcwork.git" },
    { name: "fork", url: "https://github.com/someone/arcwork.git" },
  ]

  it("uses the resolved GitHub remote's name, not a hardcoded origin", () => {
    expect(defaultBranchRemote(remotes, { remote: "arcwork" })).toBe("arcwork")
  })

  it("falls back to origin when present and no GitHub remote resolved", () => {
    expect(
      defaultBranchRemote([{ name: "x", url: "" }, { name: "origin", url: "" }], null),
    ).toBe("origin")
  })

  it("falls back to the first remote when there's no origin", () => {
    expect(defaultBranchRemote(remotes, null)).toBe("arcwork")
  })

  it("is null when the clone has no remotes", () => {
    expect(defaultBranchRemote([], null)).toBeNull()
  })
})

describe("resolveBranchRange", () => {
  const git = (cwd: string, ...args: ReadonlyArray<string>) =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString()

  it("uses the resolved default-branch remote instead of hardcoded origin", async () => {
    const repo = fs.mkdtempSync(path.join(os.tmpdir(), "arc-branch-range-"))
    try {
      git(repo, "-c", "init.defaultBranch=main", "init")
      git(repo, "config", "user.email", "test@arc.test")
      git(repo, "config", "user.name", "Arc Test")
      fs.writeFileSync(path.join(repo, "README.md"), "base\n")
      git(repo, "add", "README.md")
      git(repo, "commit", "-m", "base")
      git(repo, "update-ref", "refs/remotes/arcwork/main", "HEAD")
      git(repo, "checkout", "-b", "feature")
      git(repo, "branch", "-D", "main")
      fs.writeFileSync(path.join(repo, "feature.txt"), "feature\n")
      git(repo, "add", "feature.txt")
      git(repo, "commit", "-m", "feature")

      await expect(resolveBranchRange(repo, "feature", "main", "arcwork")).resolves.toEqual([
        "arcwork/main..HEAD",
      ])
      await expect(resolveBranchRange(repo, "feature", "main", "origin")).resolves.toEqual([])
    } finally {
      fs.rmSync(repo, { recursive: true, force: true })
    }
  })
})
