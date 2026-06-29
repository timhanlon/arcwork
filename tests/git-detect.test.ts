import { Effect, Layer, ManagedRuntime, Stream } from "effect"
import { execFileSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { GitService, GitServiceLive } from "../src/main/services/GitService.js"
import { WorkspaceService } from "../src/main/services/WorkspaceService.js"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { Workspace } from "../src/shared/workspace.js"
import { arcId } from "../src/shared/ids.js"

// Real GitService over a real on-disk git repo + the production sqlite store
// (vitest aliases native better-sqlite3 to node:sqlite). WorkspaceService is a
// stub whose `changes` stream is empty, so the layer's boot detection is a
// no-op and the test drives detectRepository explicitly — no electron dialog,
// no race with the background pass.
const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  execFileSync("git", ["-C", cwd, ...args], { stdio: "pipe" }).toString()

interface RepoFixture {
  readonly workspace: Workspace
  readonly cleanup: () => void
}

const createRepoFixture = (): RepoFixture => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-git-detect-"))
  git(repoDir, "-c", "init.defaultBranch=main", "init")
  git(repoDir, "config", "user.email", "test@arc.test")
  git(repoDir, "config", "user.name", "Arc Test")
  git(repoDir, "remote", "add", "origin", "git@github.com:acme/widgets.git")
  fs.writeFileSync(path.join(repoDir, "README.md"), "# widgets\n")
  git(repoDir, "add", "README.md")
  git(repoDir, "commit", "-m", "initial")
  return {
    workspace: {
      id: arcId("workspace", "workspace_test"),
      path: fs.realpathSync(repoDir),
      name: "widgets",
      repositoryId: null,
      repoLabel: null,
      defaultBranch: null,
      branch: null,
      isWorktree: false,
      pullRequest: null,
    },
    cleanup: () => fs.rmSync(repoDir, { recursive: true, force: true }),
  }
}

const createUnbornRepoFixture = (): RepoFixture => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "arc-git-unborn-"))
  git(repoDir, "-c", "init.defaultBranch=main", "init")
  return {
    workspace: {
      id: arcId("workspace", "workspace_unborn"),
      path: fs.realpathSync(repoDir),
      name: "unborn",
      repositoryId: null,
      repoLabel: null,
      defaultBranch: null,
      branch: null,
      isWorktree: false,
      pullRequest: null,
    },
    cleanup: () => fs.rmSync(repoDir, { recursive: true, force: true }),
  }
}

const run = async <A, E>(
  workspace: Workspace,
  program: Effect.Effect<A, E, GitService | ArcStore>,
): Promise<A> => {
  const WorkspaceStub = Layer.succeed(
    WorkspaceService,
    WorkspaceService.of({
      list: Effect.succeed([workspace]),
      get: () => Effect.succeed(workspace),
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

const withRepo = async <A>(f: (fixture: RepoFixture) => Promise<A>): Promise<A> => {
  const fixture = createRepoFixture()
  try {
    return await f(fixture)
  } finally {
    fixture.cleanup()
  }
}

const withUnbornRepo = async <A>(f: (fixture: RepoFixture) => Promise<A>): Promise<A> => {
  const fixture = createUnbornRepoFixture()
  try {
    return await f(fixture)
  } finally {
    fixture.cleanup()
  }
}

const withWorktreesRoot = async <A>(f: (root: string) => Promise<A>): Promise<A> => {
  const oldRoot = process.env["ARC_WORKTREES_DIR"]
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "arc-git-worktrees-"))
  process.env["ARC_WORKTREES_DIR"] = root
  try {
    return await f(root)
  } finally {
    if (oldRoot === undefined) delete process.env["ARC_WORKTREES_DIR"]
    else process.env["ARC_WORKTREES_DIR"] = oldRoot
    fs.rmSync(root, { recursive: true, force: true })
  }
}

const seedWorkspace = (workspace: Workspace) =>
  Effect.flatMap(ArcStore, (store) =>
    store.upsertWorkspace({
      id: workspace.id,
      path: workspace.path,
      name: workspace.name,
      createdAt: "2026-06-19T00:00:00.000Z",
      lastOpenedAt: "2026-06-19T00:00:00.000Z",
    }),
  )

describe("git repository detection", () => {
  it("persists repo identity, worktrees, and the workspace binding from a real repo", async () => {
    const result = await withRepo(({ workspace }) =>
      run(
        workspace,
        Effect.gen(function* () {
          const store = yield* ArcStore
          yield* seedWorkspace(workspace)
          const service = yield* GitService
          const repo = yield* service.detectRepository(workspace.id)
          const worktrees = repo ? yield* store.loadWorktreesForRepository(repo.id) : []
          const boundWorkspace = (yield* store.loadWorkspaces).find((w) => w.id === workspace.id)
          return { repo, worktrees, boundWorkspace }
        }),
      ),
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
    const context = await withRepo(({ workspace }) =>
      run(
        workspace,
        Effect.gen(function* () {
          const store = yield* ArcStore
          yield* seedWorkspace(workspace)
          const service = yield* GitService
          const repo = yield* service.detectRepository(workspace.id)
          // Seed a PR whose head ref is the workspace's branch (main).
          yield* store.upsertPullRequest({
            id: arcId("pr", "pr_seed"),
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
            headRepositoryOwner: "acme",
            headRepositoryName: "widgets",
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
      ),
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
  it("creates an arc-managed worktree and removes it", async () => {
    const out = await withWorktreesRoot(() =>
      withRepo(({ workspace }) =>
        run(
          workspace,
          Effect.gen(function* () {
            const store = yield* ArcStore
            yield* seedWorkspace(workspace)
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
        ),
      ),
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

  it("creates an orphan worktree for a repo with no commits yet", async () => {
    const out = await withWorktreesRoot(() =>
      withUnbornRepo(({ workspace }) =>
        run(
          workspace,
          Effect.gen(function* () {
            const store = yield* ArcStore
            yield* seedWorkspace(workspace)
            const service = yield* GitService
            yield* service.detectRepository(workspace.id)

            const wt = yield* service.createWorktree(workspace.id, { branch: "test-worktree", createBranch: true })
            const status = yield* Effect.sync(() => git(wt.path, "status", "--short", "--branch"))
            const worktrees = yield* store.loadWorktreesForRepository(wt.repositoryId)
            return { wt, status, worktrees }
          }),
        ),
      ),
    )

    expect(out.wt.branch).toBe("test-worktree")
    expect(out.status).toContain("No commits yet on test-worktree")
    expect(out.worktrees.some((w) => w.branch === "test-worktree")).toBe(true)
  })

  it("rejects carrying changes into an orphan worktree", async () => {
    const error = await withWorktreesRoot(() =>
      withUnbornRepo(({ workspace }) =>
        run(
          workspace,
          Effect.gen(function* () {
            yield* seedWorkspace(workspace)
            const service = yield* GitService
            yield* service.detectRepository(workspace.id)

            yield* Effect.sync(() => {
              fs.writeFileSync(path.join(workspace.path, "staged.txt"), "staged\n")
              git(workspace.path, "add", "staged.txt")
              fs.writeFileSync(path.join(workspace.path, "untracked.txt"), "untracked\n")
            })

            return yield* service.createWorktree(workspace.id, {
              branch: "orphan-carry",
              createBranch: true,
              carryChanges: true,
            }).pipe(Effect.flip)
          }),
        ),
      ),
    )

    expect(error.message).toContain("Cannot carry changes from a repository with no commits yet")
  })

  it("carries dirty staged, unstaged, and untracked files into a new worktree", async () => {
    const out = await withWorktreesRoot(() =>
      withRepo(({ workspace }) =>
        run(
          workspace,
          Effect.gen(function* () {
            const service = yield* GitService
            yield* seedWorkspace(workspace)
            yield* service.detectRepository(workspace.id)

            yield* Effect.sync(() => {
              fs.appendFileSync(path.join(workspace.path, "README.md"), "dirty edit\n")
              fs.writeFileSync(path.join(workspace.path, "staged.txt"), "staged\n")
              git(workspace.path, "add", "staged.txt")
              fs.writeFileSync(path.join(workspace.path, "untracked.txt"), "untracked\n")
            })

            const wt = yield* service.createWorktree(workspace.id, {
              branch: "carry-dirty",
              createBranch: true,
              carryChanges: true,
            })
            const sourceStatus = yield* Effect.sync(() => git(workspace.path, "status", "--porcelain", "-uall"))
            const destStatus = yield* Effect.sync(() => git(wt.path, "status", "--porcelain", "-uall"))
            const readme = yield* Effect.sync(() => fs.readFileSync(path.join(wt.path, "README.md"), "utf8"))
            const staged = yield* Effect.sync(() => fs.readFileSync(path.join(wt.path, "staged.txt"), "utf8"))
            const untracked = yield* Effect.sync(() => fs.readFileSync(path.join(wt.path, "untracked.txt"), "utf8"))
            return { sourceStatus, destStatus, readme, staged, untracked }
          }),
        ),
      ),
    )

    expect(out.sourceStatus).toBe("")
    expect(out.destStatus).toContain(" M README.md")
    expect(out.destStatus).toContain("A  staged.txt")
    expect(out.destStatus).toContain("?? untracked.txt")
    expect(out.readme).toContain("dirty edit")
    expect(out.staged).toBe("staged\n")
    expect(out.untracked).toBe("untracked\n")
  })

  it("cleans up the worktree and branch, preserving the stash, when carry hits a conflict", async () => {
    const out = await withWorktreesRoot(() =>
      withRepo(({ workspace }) =>
        run(
          workspace,
          Effect.gen(function* () {
            const service = yield* GitService
            yield* seedWorkspace(workspace)
            yield* service.detectRepository(workspace.id)

            // A divergent base edits the same line the dirty source edits, so
            // applying the carried stash into a worktree off that base conflicts.
            yield* Effect.sync(() => {
              git(workspace.path, "checkout", "-b", "diverge")
              fs.writeFileSync(path.join(workspace.path, "README.md"), "# widgets (other side)\n")
              git(workspace.path, "commit", "-am", "divergent edit")
              git(workspace.path, "checkout", "main")
              fs.writeFileSync(path.join(workspace.path, "README.md"), "# widgets (my side)\n")
            })

            const error = yield* service
              .createWorktree(workspace.id, {
                branch: "carry-conflict",
                baseRef: "diverge",
                createBranch: true,
                carryChanges: true,
              })
              .pipe(Effect.flip)

            const worktrees = yield* Effect.sync(() => git(workspace.path, "worktree", "list", "--porcelain"))
            const branches = yield* Effect.sync(() => git(workspace.path, "branch", "--list", "carry-conflict"))
            const stashes = yield* Effect.sync(() => git(workspace.path, "stash", "list"))
            const sourceStatus = yield* Effect.sync(() => git(workspace.path, "status", "--porcelain"))
            return { error, worktrees, branches, stashes, sourceStatus }
          }),
        ),
      ),
    )

    expect(out.error.message).toContain("restored to the original workspace")
    // The half-created tree and branch are gone, so the same name can be retried.
    expect(out.worktrees).not.toContain("carry-conflict")
    expect(out.branches.trim()).toBe("")
    // The carried changes are put back in the source, with no leftover stash.
    expect(out.stashes.trim()).toBe("")
    expect(out.sourceStatus).toContain("M README.md")
  })

  it("removes a stale read-model row when git no longer has the worktree", async () => {
    const out = await withWorktreesRoot(() =>
      withRepo(({ workspace }) =>
        run(
          workspace,
          Effect.gen(function* () {
            const store = yield* ArcStore
            yield* seedWorkspace(workspace)
            const service = yield* GitService
            yield* service.detectRepository(workspace.id)
            const wt = yield* service.createWorktree(workspace.id, { branch: "stale-tree", createBranch: true })

            yield* Effect.sync(() => {
              fs.rmSync(wt.path, { recursive: true, force: true })
              git(workspace.path, "worktree", "prune")
            })
            yield* store.upsertWorkspace({
              id: arcId("workspace", "workspace_stale_tree"),
              path: wt.path,
              name: "stale-tree",
              createdAt: "2026-06-19T00:00:00.000Z",
              lastOpenedAt: "2026-06-19T00:00:00.000Z",
            })
            yield* store.setWorkspaceGit(arcId("workspace", "workspace_stale_tree"), {
              repositoryId: wt.repositoryId,
              worktreeId: wt.id,
              gitBranch: wt.branch,
              gitHeadSha: wt.headSha,
            })
            yield* store.insertChat({
              id: arcId("chat", "chat_stale_tree"),
              workspaceId: arcId("workspace", "workspace_stale_tree"),
              title: "keep me",
              createdAt: "2026-06-19T00:00:00.000Z",
            })
            yield* store.upsertTargetSession({
              id: arcId("target", "target_stale_tree"),
              chatId: arcId("chat", "chat_stale_tree"),
              provider: "codex",
              preset: null,
              cwd: wt.path,
              nativeSessionId: null,
              nativeTranscriptPath: null,
              state: "exited",
              startedAt: "2026-06-19T00:00:00.000Z",
            })

            yield* service.removeWorktree(workspace.id, wt.path)
            const remaining = yield* store.loadWorktreesForRepository(wt.repositoryId)
            const staleWorkspace = (yield* store.loadWorkspaces).find((w) => w.path === wt.path)
            const chats = yield* store.loadChats
            const sessions = yield* store.loadTargetSessions
            const workspaceStillExists = yield* store.workspaceExists(arcId("workspace", "workspace_stale_tree"))
            const chatWorkspacePath = yield* store.workspacePathForChat(arcId("chat", "chat_stale_tree"))
            return { wt, remaining, staleWorkspace, chats, sessions, workspaceStillExists, chatWorkspacePath }
          }),
        ),
      ),
    )

    expect(out.remaining.some((w) => w.path === out.wt.path)).toBe(false)
    expect(out.staleWorkspace).toBeUndefined()
    expect(out.workspaceStillExists).toBe(true)
    expect(out.chatWorkspacePath).toBe(out.wt.path)
    expect(out.chats.some((chat) => chat.id === arcId("chat", "chat_stale_tree"))).toBe(true)
    expect(out.sessions.some((session) => session.id === arcId("target", "target_stale_tree"))).toBe(true)
  })

})
