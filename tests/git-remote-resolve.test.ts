import { describe, expect, it } from "vitest"
import { defaultBranchRemote, githubIdentity } from "../src/main/services/GitService.js"

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
