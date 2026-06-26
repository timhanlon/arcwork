import { Effect } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { RepositoryRow, WorktreeRow } from "../../db/schema.js"
import type { WorkspaceId } from "../../../shared/ids.js"
import type { Workspace } from "../../../shared/workspace.js"
import { type ArcRequestError, arcRequestError } from "../../errors.js"
import { newArcId } from "../../../shared/ids.js"
import { arcWorkWorktreePath, type ArcProfile } from "../../db/paths.js"
import { runGit, runGitCapture } from "./exec.js"
import { bool, parseWorktreeList } from "./parse.js"

export const splitNul = (stdout: string): ReadonlyArray<string> =>
  stdout.split("\0").filter((value) => value.length > 0)

/** Put carried changes back in the source workspace after a failed worktree add.
 * Returns a suffix for the error message describing where the changes ended up. */
export const restoreToSource = (sourcePath: string, ref: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const restore = yield* Effect.promise(() => runGitCapture(sourcePath, ["stash", "apply", "--index", ref]))
    if (restore.exitCode !== 0) {
      yield* Effect.logWarning(`git stash restore to source failed: ${restore.stderr.trim()}`)
      return `; changes are stashed but could not be restored — recover with 'git stash apply ${ref}'`
    }
    const drop = yield* Effect.promise(() => runGitCapture(sourcePath, ["stash", "drop", "stash@{0}"]))
    if (drop.exitCode !== 0) yield* Effect.logWarning(`git stash drop failed after restore: ${drop.stderr.trim()}`)
    return "; your changes were restored to the original workspace"
  })

/** Resolve the pushed stash to a stable OID for every `apply`. */
export const stashSha = (sourcePath: string): Effect.Effect<string, ArcRequestError> =>
  Effect.gen(function* () {
    const sha = (yield* Effect.promise(() => runGit(sourcePath, ["rev-parse", "stash@{0}"]))).stdout.trim()
    if (!sha) {
      return yield* Effect.fail(arcRequestError("git stash push succeeded but stash@{0} could not be resolved"))
    }
    return sha
  })

export interface WorktreeStore {
  readonly deleteWorktreeByPath: (path: string) => Effect.Effect<boolean, SqlError>
  readonly loadWorktreesForRepository: (repositoryId: string) => Effect.Effect<ReadonlyArray<WorktreeRow>, SqlError>
  readonly upsertWorktree: (row: WorktreeRow) => Effect.Effect<WorktreeRow, SqlError>
}

export interface WorktreeDeps {
  readonly store: WorktreeStore
  readonly profile: ArcProfile
  readonly repoSlugFor: (repo: RepositoryRow) => string
  readonly requireRepository: (workspaceId: WorkspaceId) => Effect.Effect<RepositoryRow, ArcRequestError>
  readonly detectRepository: (workspaceId: WorkspaceId) => Effect.Effect<RepositoryRow | null, ArcRequestError>
  readonly publishChange: (workspaceId: WorkspaceId) => Effect.Effect<void>
  readonly listWorkspaces: Effect.Effect<ReadonlyArray<Workspace>>
  readonly openWorkspaceAt: (worktreePath: string) => Effect.Effect<Workspace, ArcRequestError>
  readonly nowIso: Effect.Effect<string>
}

/** Run `git worktree remove` then drop the persisted row. Returns the git
 * failure text rather than raising so explicit remove can reconcile rows
 * when Git already forgot the worktree. */
export const removeManagedTree = (
  store: WorktreeStore,
  repo: RepositoryRow,
  worktreePath: string,
  options?: { readonly force?: boolean },
): Effect.Effect<{ readonly ok: true } | { readonly ok: false; readonly error: string }, ArcRequestError> =>
  Effect.gen(function* () {
    const args = ["worktree", "remove", ...(options?.force ? ["--force"] : []), worktreePath]
    const result = yield* Effect.promise(() => runGitCapture(repo.rootPath, args))
    if (result.exitCode !== 0) {
      return { ok: false, error: result.stderr.trim() || `exit ${result.exitCode}` }
    }
    yield* store
      .deleteWorktreeByPath(worktreePath)
      .pipe(Effect.mapError((e) => arcRequestError(`worktree row delete failed: ${e}`)))
    return { ok: true }
  })

export const createWorktree = (
  deps: WorktreeDeps,
  workspaceId: WorkspaceId,
  options: {
    readonly branch: string
    readonly baseRef?: string
    readonly createBranch?: boolean
    readonly carryChanges?: boolean
  },
): Effect.Effect<WorktreeRow, ArcRequestError> =>
  Effect.gen(function* () {
    const repo = yield* deps.requireRepository(workspaceId)
    const sourceWorkspace = (yield* deps.listWorkspaces).find((w) => w.id === workspaceId)
    if (!sourceWorkspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))
    const dest = arcWorkWorktreePath(deps.profile, deps.repoSlugFor(repo), options.branch)
    // `git worktree add` creates the leaf dir; ensure the repo-slug parent exists.
    yield* Effect.tryPromise({
      try: () => fs.mkdir(path.dirname(dest), { recursive: true }),
      catch: (e) => arcRequestError(`worktree dir create failed: ${e}`),
    })
    const baseRef = options.baseRef ?? repo.defaultBranch ?? "HEAD"
    const baseExists = options.createBranch
      ? (yield* Effect.promise(() => runGit(repo.rootPath, ["rev-parse", "--verify", "--quiet", `${baseRef}^{commit}`])))
          .exitCode === 0
      : true
    const createOrphan = options.baseRef === undefined && repo.defaultBranch === null && !baseExists
    if (createOrphan && options.carryChanges === true) {
      return yield* Effect.fail(
        arcRequestError(
          "Cannot carry changes from a repository with no commits yet. Make an initial commit first, or create an empty orphan worktree.",
        ),
      )
    }
    const dirty = options.carryChanges === true &&
      ((yield* Effect.promise(() => runGit(sourceWorkspace.path, ["diff", "--quiet"]))).exitCode !== 0 ||
        (yield* Effect.promise(() => runGit(sourceWorkspace.path, ["diff", "--cached", "--quiet"]))).exitCode !== 0 ||
        splitNul(
          (yield* Effect.promise(() =>
            runGit(sourceWorkspace.path, ["ls-files", "-z", "--others", "--exclude-standard"]),
          )).stdout,
        ).length > 0)
    let stashRef: string | null = null
    if (dirty) {
      const stash = yield* Effect.promise(() =>
        runGitCapture(sourceWorkspace.path, [
          "stash",
          "push",
          "--include-untracked",
          "--message",
          `arc carry changes to ${options.branch}`,
        ]),
      )
      if (stash.exitCode !== 0) {
        return yield* Effect.fail(
          arcRequestError(`git stash failed before creating worktree: ${stash.stderr.trim() || `exit ${stash.exitCode}`}`),
        )
      }
      stashRef = yield* stashSha(sourceWorkspace.path)
    }
    const args = options.createBranch
      ? createOrphan
        ? ["worktree", "add", "--orphan", "-b", options.branch, dest]
        : ["worktree", "add", "-b", options.branch, dest, baseRef]
      : ["worktree", "add", dest, options.branch]
    const result = yield* Effect.promise(() => runGitCapture(repo.rootPath, args))
    if (result.exitCode !== 0) {
      const hint = stashRef ? yield* restoreToSource(sourceWorkspace.path, stashRef) : ""
      return yield* Effect.fail(
        arcRequestError(`git worktree add failed: ${result.stderr.trim() || `exit ${result.exitCode}`}${hint}`),
      )
    }
    if (stashRef) {
      const apply = yield* Effect.promise(() => runGitCapture(dest, ["stash", "apply", "--index", stashRef]))
      if (apply.exitCode !== 0) {
        // `worktree add` already succeeded, so the tree and branch exist on
        // disk; tear them down (best-effort) so the same branch name can be
        // retried, then restore the carried changes to the source. Delete the
        // branch only after the tree is gone (a checked-out branch can't be
        // deleted) and only if we created it.
        const removeTree = yield* Effect.promise(() =>
          runGitCapture(repo.rootPath, ["worktree", "remove", "--force", dest]),
        )
        if (removeTree.exitCode !== 0) {
          yield* Effect.logWarning(`worktree cleanup failed after stash apply failure: ${removeTree.stderr.trim()}`)
        } else if (options.createBranch) {
          const deleteBranch = yield* Effect.promise(() =>
            runGitCapture(repo.rootPath, ["branch", "-D", options.branch]),
          )
          if (deleteBranch.exitCode !== 0) {
            yield* Effect.logWarning(`branch cleanup failed after stash apply failure: ${deleteBranch.stderr.trim()}`)
          }
        }
        const hint = yield* restoreToSource(sourceWorkspace.path, stashRef)
        return yield* Effect.fail(
          arcRequestError(
            `git stash apply failed in new worktree: ${apply.stderr.trim() || `exit ${apply.exitCode}`}${hint}`,
          ),
        )
      }
      const drop = yield* Effect.promise(() => runGitCapture(repo.rootPath, ["stash", "drop", "stash@{0}"]))
      if (drop.exitCode !== 0) yield* Effect.logWarning(`git stash drop failed after carry: ${drop.stderr.trim()}`)
    }
    // detectRepository re-enumerates every worktree under the common git dir,
    // so the new tree lands in the read model; read it back to return its row.
    const detectedRepo = yield* deps.detectRepository(workspaceId)
    const repository = detectedRepo ?? repo
    const rows = yield* deps.store
      .loadWorktreesForRepository(repository.id)
      .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
    // Match on branch, not path: git reports the canonical (symlink-resolved)
    // path, which can differ from `dest` (e.g. /private/var vs /var on macOS),
    // and a branch is checked out in at most one worktree.
    let created = rows.find((w) => w.branch === options.branch)
    if (!created) {
      const liveWorktrees = parseWorktreeList(
        (yield* Effect.promise(() => runGit(repo.rootPath, ["worktree", "list", "--porcelain"]))).stdout,
      )
      const liveCreated = liveWorktrees.find((w) => w.branch === options.branch)
      if (liveCreated) {
        const now = yield* deps.nowIso
        created = yield* deps.store.upsertWorktree({
          id: newArcId("worktree"),
          repositoryId: repository.id,
          path: liveCreated.path,
          branch: liveCreated.branch,
          headSha: liveCreated.headSha,
          isDetached: bool(liveCreated.isDetached),
          isBare: bool(liveCreated.isBare),
          isLocked: bool(liveCreated.isLocked),
          lockedReason: liveCreated.lockedReason,
          isPrunable: bool(liveCreated.isPrunable),
          prunableReason: liveCreated.prunableReason,
          createdAt: now,
          lastSeenAt: now,
        }).pipe(Effect.mapError((e) => arcRequestError(`worktree persist failed: ${e}`)))
      }
    }
    if (!created) return yield* Effect.fail(arcRequestError(`worktree created but not found for ${options.branch}`))
    yield* deps.publishChange(workspaceId)
    return created
  }).pipe(Effect.withSpan("arc.git.create_worktree", { attributes: { "arc.workspace_id": workspaceId } }))

export const openWorktree = (
  deps: Pick<WorktreeDeps, "openWorkspaceAt" | "detectRepository" | "publishChange">,
  worktreePath: string,
): Effect.Effect<Workspace, ArcRequestError> =>
  Effect.gen(function* () {
    const workspace = yield* deps.openWorkspaceAt(worktreePath)
    yield* deps.detectRepository(workspace.id)
    yield* deps.publishChange(workspace.id)
    return workspace
  }).pipe(Effect.withSpan("arc.git.open_worktree", { attributes: { "arc.worktree_path": worktreePath } }))

export const removeWorktree = (
  deps: Pick<WorktreeDeps, "store" | "requireRepository" | "publishChange">,
  workspaceId: WorkspaceId,
  worktreePath: string,
  options?: { readonly force?: boolean },
): Effect.Effect<void, ArcRequestError> =>
  Effect.gen(function* () {
    const repo = yield* deps.requireRepository(workspaceId)
    if (path.resolve(worktreePath) === path.resolve(repo.rootPath)) {
      return yield* Effect.fail(arcRequestError("Refusing to remove the main worktree"))
    }
    const outcome = yield* removeManagedTree(deps.store, repo, worktreePath, options)
    if (!outcome.ok) {
      const live = parseWorktreeList(
        (yield* Effect.promise(() => runGit(repo.rootPath, ["worktree", "list", "--porcelain"]))).stdout,
      )
      const stillRegistered = live.some((w) => path.resolve(w.path) === path.resolve(worktreePath))
      if (!stillRegistered) {
        yield* deps.store
          .deleteWorktreeByPath(worktreePath)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree row delete failed: ${e}`)))
        yield* deps.publishChange(workspaceId)
        return
      }
      return yield* Effect.fail(arcRequestError(`git worktree remove failed: ${outcome.error}`))
    }
    yield* deps.publishChange(workspaceId)
  }).pipe(Effect.withSpan("arc.git.remove_worktree", { attributes: { "arc.workspace_id": workspaceId } }))

export const pruneWorktrees = (
  deps: Pick<WorktreeDeps, "store" | "requireRepository" | "publishChange">,
  workspaceId: WorkspaceId,
): Effect.Effect<number, ArcRequestError> =>
  Effect.gen(function* () {
    const repo = yield* deps.requireRepository(workspaceId)
    const result = yield* Effect.promise(() => runGitCapture(repo.rootPath, ["worktree", "prune"]))
    if (result.exitCode !== 0) {
      return yield* Effect.fail(
        arcRequestError(`git worktree prune failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`),
      )
    }
    // Reconcile: git no longer lists pruned trees, so drop their stale rows
    // (detectRepository only upserts; it never deletes vanished worktrees).
    const live = parseWorktreeList(
      (yield* Effect.promise(() => runGit(repo.rootPath, ["worktree", "list", "--porcelain"]))).stdout,
    )
    const livePaths = new Set(live.map((w) => path.resolve(w.path)))
    const persisted = yield* deps.store
      .loadWorktreesForRepository(repo.id)
      .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
    let removed = 0
    for (const row of persisted) {
      if (livePaths.has(path.resolve(row.path))) continue
      yield* deps.store
        .deleteWorktreeByPath(row.path)
        .pipe(Effect.mapError((e) => arcRequestError(`worktree row delete failed: ${e}`)))
      removed++
    }
    if (removed > 0) yield* deps.publishChange(workspaceId)
    return removed
  }).pipe(Effect.withSpan("arc.git.prune_worktrees", { attributes: { "arc.workspace_id": workspaceId } }))
