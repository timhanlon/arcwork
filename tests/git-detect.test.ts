import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { GitService, GitServiceLive } from "../src/main/services/GitService.js"
import { WorkspaceService } from "../src/main/services/WorkspaceService.js"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { Workspace } from "../src/shared/workspace.js"

// Real GitService over a real on-disk git repo + the production sqlite store
// (vitest aliases native better-sqlite3 to node:sqlite). WorkspaceService is a
// stub whose `changes` stream is empty, so the layer's boot detection is a
// no-op and the test drives detectRepository explicitly — no electron dialog,
// no race with the background pass.
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString()

let repoDir: string
let workspace: Workspace

beforeAll(() => {
  repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-git-detect-"))
  git(repoDir, "-c", "init.defaultBranch=main", "init")
  git(repoDir, "config", "user.email", "test@arc.test")
  git(repoDir, "config", "user.name", "Arc Test")
  git(repoDir, "remote", "add", "origin", "git@github.com:acme/widgets.git")
  fs.writeFileSync(path.join(repoDir, "README.md"), "# widgets\n")
  git(repoDir, "add", "README.md")
  git(repoDir, "commit", "-m", "initial")
  workspace = {
    id: "workspace_test",
    path: fs.realpathSync(repoDir),
    name: "widgets",
    repositoryId: null,
    repoLabel: null,
    defaultBranch: null,
    branch: null,
    isWorktree: false,
  }
})

afterAll(() => {
  fs.rmSync(repoDir, { recursive: true, force: true })
})

const run = async <A, E>(program: Effect.Effect<A, E, GitService | ArcStore>): Promise<A> => {
  const WorkspaceStub = Layer.succeed(
    WorkspaceService,
    WorkspaceService.of({
      list: Effect.succeed([workspace]),
      changes: Stream.empty,
      open: Effect.succeed(undefined),
      openAt: () => Effect.succeed(workspace),
      refresh: Effect.void,
    }),
  )
  const StoreLive = ArcStoreLive.pipe(Layer.provide(sqliteLayer(":memory:")))
  const GitLive = GitServiceLive.pipe(Layer.provide(WorkspaceStub), Layer.provide(StoreLive))
  const runtime = ManagedRuntime.make(Layer.mergeAll(StoreLive, GitLive))
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

describe("git repository detection", () => {
  it("persists repo identity, worktrees, and the workspace binding from a real repo", async () => {
    const result = await run(
      Effect.gen(function* () {
        const store = yield* ArcStore
        yield* store.upsertWorkspace({
          id: workspace.id,
          path: workspace.path,
          name: workspace.name,
          createdAt: "2026-06-19T00:00:00.000Z",
          lastOpenedAt: "2026-06-19T00:00:00.000Z",
        })
        const service = yield* GitService
        const repo = yield* service.detectRepository(workspace.id)
        const worktrees = repo ? yield* store.loadWorktreesForRepository(repo.id) : []
        const boundWorkspace = (yield* store.loadWorkspaces).find((w) => w.id === workspace.id)
        return { repo, worktrees, boundWorkspace }
      }),
    )

    // GitHub identity resolved from the SCP-style remote.
    expect(result.repo?.githubOwner).toBe("acme")
    expect(result.repo?.githubRepo).toBe("widgets")
    expect(result.repo?.commonGitDir).toMatch(/\.git$/)
    expect(JSON.parse(result.repo!.remotesJson)).toEqual([
      { name: "origin", url: "git@github.com:acme/widgets.git" },
    ])

    // The single (main) worktree is recorded on the branch we initialised.
    expect(result.worktrees).toHaveLength(1)
    expect(result.worktrees[0]!.branch).toBe("main")
    expect(result.worktrees[0]!.headSha).toMatch(/^[0-9a-f]{40}$/)

    // The workspace is bound into the git domain with its cached snapshot.
    expect(result.boundWorkspace?.repositoryId).toBe(result.repo!.id)
    expect(result.boundWorkspace?.worktreeId).toBe(result.worktrees[0]!.id)
    expect(result.boundWorkspace?.gitBranch).toBe("main")
  })

  it("gitContext maps the current branch to a persisted PR", async () => {
    const context = await run(
      Effect.gen(function* () {
        const store = yield* ArcStore
        yield* store.upsertWorkspace({
          id: workspace.id,
          path: workspace.path,
          name: workspace.name,
          createdAt: "2026-06-19T00:00:00.000Z",
          lastOpenedAt: "2026-06-19T00:00:00.000Z",
        })
        const service = yield* GitService
        const repo = yield* service.detectRepository(workspace.id)
        // Seed a PR whose head ref is the workspace's branch (main).
        yield* store.upsertPullRequest({
          id: "pr_seed",
          repositoryId: repo!.id,
          number: 99,
          githubNodeId: null,
          title: "the open PR",
          body: "",
          state: "open",
          isDraft: 0,
          author: "octocat",
          headRef: "main",
          headSha: null,
          baseRef: "main",
          reviewState: null,
          checksState: "passing",
          mergeable: null,
          mergeStateStatus: null,
          url: null,
          lastSyncedAt: "2026-06-19T00:00:00.000Z",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
        })
        return yield* service.gitContext(workspace.id)
      }),
    )

    expect(context.branch).toBe("main")
    expect(context.repository?.githubRepo).toBe("widgets")
    expect(context.worktrees).toHaveLength(1)
    expect(context.currentPullRequest?.number).toBe(99)
    expect(context.currentPullRequest?.checksState).toBe("passing")
    expect(context.currentPullRequest?.isDraft).toBe(false)
  })
})

describe("git worktree lifecycle", () => {
  // arc-managed worktrees land under `~/.arcwork/<profile>/worktrees`; pin that
  // root at a throwaway dir via the ARC_WORKTREES_DIR escape hatch (surgical —
  // unlike redirecting HOME, it touches nothing else). Set before any run()
  // builds the layer, which resolves the managed root at build time.
  let worktreesRoot: string
  let oldRoot: string | undefined

  beforeAll(() => {
    oldRoot = process.env["ARC_WORKTREES_DIR"]
    worktreesRoot = fs.mkdtempSync(path.join(os.tmpdir(), "arc-git-worktrees-"))
    process.env["ARC_WORKTREES_DIR"] = worktreesRoot
  })

  afterAll(() => {
    if (oldRoot === undefined) delete process.env["ARC_WORKTREES_DIR"]
    else process.env["ARC_WORKTREES_DIR"] = oldRoot
    fs.rmSync(worktreesRoot, { recursive: true, force: true })
  })

  const seedWorkspace = Effect.flatMap(ArcStore, (store) =>
    store.upsertWorkspace({
      id: workspace.id,
      path: workspace.path,
      name: workspace.name,
      createdAt: "2026-06-19T00:00:00.000Z",
      lastOpenedAt: "2026-06-19T00:00:00.000Z",
    }),
  )

  it("creates an arc-managed worktree and removes it", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* ArcStore
        yield* seedWorkspace
        const service = yield* GitService
        yield* service.detectRepository(workspace.id)

        const wt = yield* service.createWorktree(workspace.id, { branch: "feature-x", createBranch: true })
        const existsOnDisk = yield* Effect.sync(() => fs.existsSync(wt.path))
        const afterCreate = yield* store.loadWorktreesForRepository(wt.repositoryId)

        yield* service.removeWorktree(workspace.id, wt.path)
        const goneOnDisk = yield* Effect.sync(() => fs.existsSync(wt.path))
        const afterRemove = yield* store.loadWorktreesForRepository(wt.repositoryId)
        return { wt, existsOnDisk, afterCreate, goneOnDisk, afterRemove }
      }),
    )

    expect(out.wt.branch).toBe("feature-x")
    // Filed under the managed root as <repo-slug>/<branch-slug>.
    expect(out.wt.path).toContain(path.join("widgets", "feature-x"))
    expect(out.existsOnDisk).toBe(true)
    expect(out.afterCreate.some((w) => w.branch === "feature-x")).toBe(true)
    // remove deletes both the tree on disk and its read-model row.
    expect(out.goneOnDisk).toBe(false)
    expect(out.afterRemove.some((w) => w.branch === "feature-x")).toBe(false)
  })

  it("auto-prunes a clean managed worktree whose PR has merged", async () => {
    const out = await run(
      Effect.gen(function* () {
        const store = yield* ArcStore
        yield* seedWorkspace
        const service = yield* GitService
        const repo = yield* service.detectRepository(workspace.id)
        const wt = yield* service.createWorktree(workspace.id, { branch: "merged-feature", createBranch: true })
        // A merged PR for that branch is the signal that makes the tree prunable.
        yield* store.upsertPullRequest({
          id: "pr_merged",
          repositoryId: repo!.id,
          number: 7,
          githubNodeId: null,
          title: "done",
          body: "",
          state: "merged",
          isDraft: 0,
          author: "octocat",
          headRef: "merged-feature",
          headSha: null,
          baseRef: "main",
          reviewState: null,
          checksState: null,
          mergeable: null,
          mergeStateStatus: null,
          url: null,
          lastSyncedAt: "2026-06-19T00:00:00.000Z",
          createdAt: "2026-06-19T00:00:00.000Z",
          updatedAt: "2026-06-19T00:00:00.000Z",
        })

        const pruned = yield* service.pruneMergedWorktrees(workspace.id)
        const goneOnDisk = yield* Effect.sync(() => fs.existsSync(wt.path))
        const remaining = yield* store.loadWorktreesForRepository(repo!.id)
        return { wt, pruned, goneOnDisk, remaining }
      }),
    )

    expect(out.pruned).toContain(out.wt.path)
    expect(out.goneOnDisk).toBe(false)
    expect(out.remaining.some((w) => w.branch === "merged-feature")).toBe(false)
    // The main worktree is never auto-pruned.
    expect(out.remaining.some((w) => w.branch === "main")).toBe(true)
  })
})
