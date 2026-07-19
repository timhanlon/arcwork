import { describe, expect, it } from "vitest"
import type { Workspace } from "../src/shared/workspace.js"
import { arcId } from "../src/shared/ids.js"
import {
  fileHrefToPath,
  resolveWorkspaceFile,
} from "../src/renderer/src/shell/workspaceFilePath.js"

// Only `id` and `path` are read by the resolver; the rest is filler to satisfy
// the schema type.
const ws = (path: string): Workspace => ({
  id: arcId("workspace", path.replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 20)),
  path,
  name: path.split("/").pop() ?? path,
  repositoryId: null,
  repoLabel: null,
  defaultBranch: null,
  branch: null,
  isWorktree: false,
  pullRequest: null,
})

describe("fileHrefToPath", () => {
  it("passes a bare absolute POSIX path through", () => {
    expect(fileHrefToPath("/Users/tim/dev/analytics/public/tracker.js")).toEqual({
      path: "/Users/tim/dev/analytics/public/tracker.js",
    })
  })

  it("decodes a file:// URL to its path", () => {
    expect(fileHrefToPath("file:///Users/tim/dev/a%20b/x.ts")).toEqual({
      path: "/Users/tim/dev/a b/x.ts",
    })
  })

  it("captures a `path:line` locator and strips it from the path", () => {
    // Regression: `README.md:7` reached realpath verbatim → ENOENT.
    expect(fileHrefToPath("/Users/tim/dev/arc-test/README.md:7")).toEqual({
      path: "/Users/tim/dev/arc-test/README.md",
      line: 7,
    })
  })

  it("captures the line from `path:line:col`, ignoring the column", () => {
    expect(fileHrefToPath("/Users/tim/dev/x.ts:42:9")).toEqual({
      path: "/Users/tim/dev/x.ts",
      line: 42,
    })
  })

  it("captures a GitHub `#Lline` anchor", () => {
    expect(fileHrefToPath("/Users/tim/dev/x.ts#L20")).toEqual({
      path: "/Users/tim/dev/x.ts",
      line: 20,
    })
    expect(fileHrefToPath("/Users/tim/dev/x.ts#L20C5")).toEqual({
      path: "/Users/tim/dev/x.ts",
      line: 20,
    })
  })

  it("leaves a path with no numeric locator intact", () => {
    // A trailing colon without digits isn't a line locator.
    expect(fileHrefToPath("/Users/tim/dev/weird:name.ts")).toEqual({
      path: "/Users/tim/dev/weird:name.ts",
    })
  })

  it("rejects relative and non-file schemes", () => {
    expect(fileHrefToPath("src/index.ts")).toBeUndefined()
    expect(fileHrefToPath("https://example.com/x")).toBeUndefined()
    expect(fileHrefToPath("mailto:a@b.c")).toBeUndefined()
    expect(fileHrefToPath("arc://work/work_1")).toBeUndefined()
  })
})

describe("resolveWorkspaceFile", () => {
  const workspaces = [ws("/Users/tim/dev/analytics"), ws("/Users/tim/dev/aux")]

  it("splits an inside-workspace path into id + relative path", () => {
    const r = resolveWorkspaceFile(workspaces, "/Users/tim/dev/analytics/public/tracker.js")
    expect(r?.workspaceId).toBe(workspaces[0]!.id)
    expect(r?.path).toBe("public/tracker.js")
  })

  it("returns undefined for a path outside every workspace", () => {
    expect(resolveWorkspaceFile(workspaces, "/etc/hosts")).toBeUndefined()
  })

  it("does not match the workspace root itself (a directory, not a file)", () => {
    expect(resolveWorkspaceFile(workspaces, "/Users/tim/dev/analytics")).toBeUndefined()
  })

  it("does not match a sibling sharing the root's prefix", () => {
    // …/analytics must not swallow …/analytics-old
    expect(resolveWorkspaceFile(workspaces, "/Users/tim/dev/analytics-old/x.ts")).toBeUndefined()
  })

  it("prefers the longest matching root for a nested worktree", () => {
    const nested = [ws("/Users/tim/dev/repo"), ws("/Users/tim/dev/repo/wt")]
    const r = resolveWorkspaceFile(nested, "/Users/tim/dev/repo/wt/src/a.ts")
    expect(r?.workspaceId).toBe(nested[1]!.id)
    expect(r?.path).toBe("src/a.ts")
  })
})
