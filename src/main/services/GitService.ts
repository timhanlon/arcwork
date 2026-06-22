import { Context, Duration, Effect, Fiber, Layer, PubSub, Stream } from "effect"
import * as fs from "node:fs/promises"
import { realpathSync } from "node:fs"
import * as path from "node:path"
import type {
  GitCommit,
  GitFileChange,
  GitFileDiff,
  GitStatus,
  WorkspaceGitContext,
} from "../../shared/git.js"
import type { PullRequestRow, RepositoryRow, WorktreeRow } from "../db/schema.js"
import type { Workspace } from "../../shared/workspace.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { WorkspaceService } from "./WorkspaceService.js"
import { ArcStore } from "../db/store.js"
import { newArcId } from "../../shared/ids.js"
import { nowIso } from "../clock.js"
import { arcWorkWorktreePath, arcWorkWorktreesDir, resolveProfile } from "../db/paths.js"
import { runGh, runGit, runGitCapture } from "./git/exec.js"
import {
  bool,
  defaultBranchRemote,
  GH_PR_FIELDS,
  type GhPullRequest,
  githubIdentity,
  parseRemotes,
  parseRemotesJson,
  parseStatusLine,
  parseWorktreeList,
  resolveBranchRange,
  statusOrder,
  trackedStats,
  trimmedOrUndefined,
  untrackedStat,
} from "./git/parse.js"
import { mapGhPullRequest, toWirePullRequest, toWireRepository, toWireWorktree } from "./git/wire.js"

export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (workspaceId: string) => Effect.Effect<GitStatus, ArcRequestError>
    readonly diff: (workspaceId: string, filePath: string) => Effect.Effect<GitFileDiff, ArcRequestError>
    /** Recent commits on the workspace's current branch (newest first). Empty when
     * the cwd is not a git repo or the branch is unborn. */
    readonly commits: (
      workspaceId: string,
      limit?: number,
    ) => Effect.Effect<ReadonlyArray<GitCommit>, ArcRequestError>
    /** Detect the workspace's git identity from its cwd and persist it: upsert
     * the repository (clone identity + resolved GitHub owner/repo), upsert every
     * worktree under its common git dir, and bind the workspace (repository,
     * worktree, cached branch/head). Idempotent — safe to re-run. Resolves to the
     * persisted repository, or null when the cwd is not inside a git work tree. */
    readonly detectRepository: (
      workspaceId: string,
    ) => Effect.Effect<RepositoryRow | null, ArcRequestError>
    /** Sync the workspace repository's GitHub pull requests via `gh` and persist
     * them into the PR read model. Detects the repo first (so the GitHub
     * owner/repo is known), shells out to `gh pr list`, and upserts each PR.
     * Resolves to the persisted rows — empty when the repo has no GitHub remote
     * or `gh` is unavailable/unauthenticated (logged, never fatal). */
    readonly syncPullRequests: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<PullRequestRow>, ArcRequestError>
    /** Assemble the workspace's git context for the renderer: detect the repo
     * (local git only — no network), then read the persisted worktrees, current
     * branch, and the PR that branch maps to. */
    readonly gitContext: (
      workspaceId: string,
    ) => Effect.Effect<WorkspaceGitContext, ArcRequestError>
    /** Live "the git read model changed for this workspace" stream — the
     * renderer re-pulls `gitContext` on each tick. Backed by a PubSub the hook
     * refresh paths below publish onto. */
    readonly changes: Stream.Stream<GitChange>
    /** A `post-checkout` hook fired (branch switch / `git worktree add`) at this
     * cwd: re-detect every workspace under that worktree root so its cached
     * branch/head — the branch→PR map — is fresh, then notify the renderer.
     * Best-effort: a non-repo cwd or any failure is logged, never raised. */
    readonly notifyCheckout: (cwd: string) => Effect.Effect<void>
    /** A `pre-push` hook fired at this cwd. Because pre-push runs before the
     * network round-trip, GitHub PR state is still stale, so this schedules a
     * DEBOUNCED PR sync (per workspace, latest push wins) rather than syncing
     * now. Best-effort. */
    readonly notifyPrePush: (cwd: string) => Effect.Effect<void>
    /** Create an arc-managed worktree for `branch` under the workspace's repo.
     * The tree lands in `~/.arcwork/<profile>/worktrees/<repo>/<branch>` (arc
     * owns it). `createBranch` makes a new branch off `baseRef` (default branch
     * when omitted); otherwise `branch` must already exist. Resolves to the
     * persisted worktree row. */
    readonly createWorktree: (
      workspaceId: string,
      options: {
        readonly branch: string
        readonly baseRef?: string
        readonly createBranch?: boolean
      },
    ) => Effect.Effect<WorktreeRow, ArcRequestError>
    /** Open an existing worktree path as a workspace (no dialog): register the
     * workspace, detect/bind its repo+branch, and return it. */
    readonly openWorktree: (worktreePath: string) => Effect.Effect<Workspace, ArcRequestError>
    /** Remove a worktree via `git worktree remove` and drop its read-model row.
     * Refuses the main worktree; without `force`, git refuses a dirty/locked
     * tree. */
    readonly removeWorktree: (
      workspaceId: string,
      worktreePath: string,
      options?: { readonly force?: boolean },
    ) => Effect.Effect<void, ArcRequestError>
    /** `git worktree prune` for missing trees, then reconcile the read model.
     * Resolves to the number of stale rows removed. */
    readonly pruneWorktrees: (workspaceId: string) => Effect.Effect<number, ArcRequestError>
    /** Auto-prune arc-managed worktrees whose branch has a merged PR — the
     * "remove after merge when safe" lifecycle step. Skips the main worktree,
     * non-arc-managed trees, and any tree with uncommitted changes. Resolves to
     * the paths actually pruned. */
    readonly pruneMergedWorktrees: (
      workspaceId: string,
    ) => Effect.Effect<ReadonlyArray<string>, ArcRequestError>
    /** Open a GitHub PR for the workspace's current branch via `gh pr create`
     * (base = repo default branch unless overridden), then sync it into the read
     * model. Resolves to the new PR row, or null if it couldn't be read back. */
    readonly createPullRequest: (
      workspaceId: string,
      options: {
        readonly title?: string
        readonly body?: string
        readonly base?: string
        readonly draft?: boolean
      },
    ) => Effect.Effect<PullRequestRow | null, ArcRequestError>
  }
>()("GitService") {}

/** A tiny git-read-model change descriptor: which workspace's repo/PR state
 * moved. Carries no data — the renderer re-pulls `gitContext` for that id. */
export interface GitChange {
  readonly workspaceId: string
}

const resolveWorkspace = (workspaces: ReadonlyArray<Workspace>, workspaceId: string): Workspace | undefined =>
  workspaces.find((w) => w.id === workspaceId)

export const GitServiceLive = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceService
    const store = yield* ArcStore

    // Invalidation bus for the renderer's git context. Unbounded so a publish
    // (from the hook refresh paths below) never blocks the refreshing fiber.
    const updates = yield* PubSub.unbounded<GitChange>()
    const changes = Stream.fromPubSub(updates)
    const publishChange = (workspaceId: string) => PubSub.publish(updates, { workspaceId })
    // The layer's own scope — debounced pre-push syncs fork into it (not the
    // caller's), so a delayed sync outlives the hook signal that scheduled it
    // and is interrupted only on app shutdown.
    const scope = yield* Effect.scope

    const detectRepository = (
      workspaceId: string,
    ): Effect.Effect<RepositoryRow | null, ArcRequestError> =>
      Effect.gen(function* () {
        const workspace = resolveWorkspace(yield* workspaces.list, workspaceId)
        if (!workspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))
        const cwd = workspace.path

        const inside = yield* Effect.promise(() => runGit(cwd, ["rev-parse", "--is-inside-work-tree"]))
        if (inside.stdout.trim() !== "true") return null

        const [commonDirRaw, remotesRaw, worktreesRaw] = yield* Effect.promise(async () =>
          Promise.all([
            runGit(cwd, ["rev-parse", "--git-common-dir"]),
            runGit(cwd, ["remote", "-v"]),
            runGit(cwd, ["worktree", "list", "--porcelain"]),
          ]),
        )

        // --git-common-dir is relative to cwd; resolve to an absolute, canonical
        // key so two workspaces in the same clone map to one repository row.
        const commonGitDir = path.resolve(cwd, commonDirRaw.stdout.trim())
        const remotes = parseRemotes(remotesRaw.stdout)
        const github = githubIdentity(remotes)
        const worktrees = parseWorktreeList(worktreesRaw.stdout)
        // Default branch = the resolved remote's HEAD (not a hardcoded `origin`,
        // which isn't always the remote's name). `<remote>/HEAD` is only set when
        // the clone tracked it (git clone, or `git remote set-head`); null otherwise.
        const headRemote = defaultBranchRemote(remotes, github)
        const defaultBranch = headRemote
          ? yield* Effect.promise(() =>
              runGit(cwd, ["symbolic-ref", "--short", `refs/remotes/${headRemote}/HEAD`]),
            ).pipe(
              Effect.map((head) => {
                // `git symbolic-ref --short` yields e.g. `arcwork/main`; strip the
                // `<remote>/` prefix to leave the bare branch name.
                const short = head.exitCode === 0 ? head.stdout.trim() : ""
                const prefix = `${headRemote}/`
                const branch = short.startsWith(prefix) ? short.slice(prefix.length) : short
                return trimmedOrUndefined(branch) ?? null
              }),
            )
          : null
        // The main worktree is the first porcelain record; fall back to the
        // common git dir's parent when the list is unexpectedly empty.
        const rootPath = worktrees[0]?.path ?? path.dirname(commonGitDir)

        const now = yield* nowIso
        const repository = yield* store.upsertRepository({
          id: newArcId("repo"),
          commonGitDir,
          rootPath,
          defaultBranch,
          remotesJson: JSON.stringify(remotes),
          githubOwner: github?.owner ?? null,
          githubRepo: github?.repo ?? null,
          githubNodeId: null,
          createdAt: now,
          lastSeenAt: now,
        }).pipe(Effect.mapError((e) => arcRequestError(`repository persist failed: ${e}`)))

        for (const entry of worktrees) {
          yield* store.upsertWorktree({
            id: newArcId("worktree"),
            repositoryId: repository.id,
            path: entry.path,
            branch: entry.branch,
            headSha: entry.headSha,
            isDetached: bool(entry.isDetached),
            isBare: bool(entry.isBare),
            isLocked: bool(entry.isLocked),
            lockedReason: entry.lockedReason,
            isPrunable: bool(entry.isPrunable),
            prunableReason: entry.prunableReason,
            createdAt: now,
            lastSeenAt: now,
          }).pipe(Effect.mapError((e) => arcRequestError(`worktree persist failed: ${e}`)))
        }

        // Bind the workspace to the worktree it actually sits in (matched on the
        // worktree's toplevel), caching its branch/head for fast UI.
        const toplevel = (yield* Effect.promise(() => runGit(cwd, ["rev-parse", "--show-toplevel"]))).stdout.trim()
        const ownWorktree = worktrees.find((w) => path.resolve(w.path) === path.resolve(toplevel))
        const persistedWorktrees = yield* store
          .loadWorktreesForRepository(repository.id)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
        const worktreeId = ownWorktree
          ? persistedWorktrees.find((w) => path.resolve(w.path) === path.resolve(ownWorktree.path))?.id ?? null
          : null

        yield* store.setWorkspaceGit(workspaceId, {
          repositoryId: repository.id,
          worktreeId,
          gitBranch: ownWorktree?.branch ?? null,
          gitHeadSha: ownWorktree?.headSha ?? null,
        }).pipe(Effect.mapError((e) => arcRequestError(`workspace bind failed: ${e}`)))

        // Push the freshly-bound repo/branch onto the workspace list so the
        // sidebar's project grouping reflects detection without a reload.
        yield* workspaces.refresh

        return repository
      }).pipe(Effect.withSpan("arc.git.detect_repository", { attributes: { "arc.workspace_id": workspaceId } }))

    const syncPullRequests = (
      workspaceId: string,
    ): Effect.Effect<ReadonlyArray<PullRequestRow>, ArcRequestError> =>
      Effect.gen(function* () {
        const repository = yield* detectRepository(workspaceId)
        if (!repository) return []
        if (!repository.githubOwner || !repository.githubRepo) {
          yield* Effect.logDebug(`PR sync skipped: no GitHub remote for ${repository.rootPath}`)
          return []
        }
        const slug = `${repository.githubOwner}/${repository.githubRepo}`

        const result = yield* Effect.promise(() =>
          runGh(repository.rootPath, [
            "pr",
            "list",
            "--repo",
            slug,
            "--state",
            "all",
            "--limit",
            "100",
            "--json",
            GH_PR_FIELDS,
          ]),
        )
        if (result.errored) {
          yield* Effect.logWarning(`PR sync skipped: gh not available for ${slug}`)
          return []
        }
        if (result.exitCode !== 0) {
          yield* Effect.logWarning(`PR sync failed for ${slug} (gh exit ${result.exitCode})`)
          return []
        }

        const parsed = yield* Effect.try({
          try: () => JSON.parse(result.stdout) as ReadonlyArray<GhPullRequest>,
          catch: (e) => arcRequestError(`PR sync parse failed for ${slug}: ${e}`),
        })

        const now = yield* nowIso
        const rows: Array<PullRequestRow> = []
        for (const raw of parsed) {
          const persisted = yield* store
            .upsertPullRequest(mapGhPullRequest(repository.id, newArcId("pr"), raw, now))
            .pipe(Effect.mapError((e) => arcRequestError(`PR persist failed for ${slug}#${raw.number}: ${e}`)))
          rows.push(persisted)
        }
        yield* Effect.logDebug(`PR sync: ${rows.length} PRs for ${slug}`)
        // Re-project the workspace list so the sidebar's branch→PR chip reflects
        // the freshly synced PRs (the chip rides the WatchWorkspaces stream).
        if (rows.length > 0) yield* workspaces.refresh
        return rows
      }).pipe(Effect.withSpan("arc.git.sync_pull_requests", { attributes: { "arc.workspace_id": workspaceId } }))

    // A pure read of the persisted git read model — no git plumbing. Repository
    // identity, worktrees, and the cached branch are populated by detection
    // (boot pass, post-checkout hook, worktree mutations) and PRs by the sync;
    // this just joins those stored rows, so it's cheap to call on every workspace
    // switch and never competes with the switch's own DB reads.
    const gitContext = (
      workspaceId: string,
    ): Effect.Effect<WorkspaceGitContext, ArcRequestError> =>
      Effect.gen(function* () {
        const workspaceRow = (yield* store.loadWorkspaces.pipe(
          Effect.mapError((e) => arcRequestError(`workspace load failed: ${e}`)),
        )).find((w) => w.id === workspaceId)
        const branch = workspaceRow?.gitBranch ?? null
        const repository = workspaceRow?.repositoryId
          ? yield* store
              .repositoryById(workspaceRow.repositoryId)
              .pipe(Effect.mapError((e) => arcRequestError(`repository load failed: ${e}`)))
          : null
        if (!repository) {
          return { workspaceId, branch, repository: null, worktrees: [], currentPullRequest: null }
        }
        const worktrees = yield* store
          .loadWorktreesForRepository(repository.id)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
        const currentPr = branch
          ? yield* store
              .pullRequestForBranch(repository.id, branch)
              .pipe(Effect.mapError((e) => arcRequestError(`PR lookup failed: ${e}`)))
          : null
        return {
          workspaceId,
          branch,
          repository: toWireRepository(repository),
          worktrees: worktrees.map(toWireWorktree),
          currentPullRequest: currentPr ? toWirePullRequest(currentPr) : null,
        }
      }).pipe(Effect.withSpan("arc.git.context", { attributes: { "arc.workspace_id": workspaceId } }))

    // Detect each workspace once per session — the changes stream emits the
    // current list on subscribe (boot) and again on every open, so a `seen`
    // guard keeps detection to one pass per workspace. Branch/PR refresh on
    // later events (post-checkout hook, explicit refresh) is a separate path.
    const seen = new Set<string>()
    yield* workspaces.changes.pipe(
      Stream.runForEach((list) =>
        Effect.forEach(
          list.filter((w) => !seen.has(w.id)),
          (w) => {
            seen.add(w.id)
            return detectRepository(w.id).pipe(
              Effect.catch((e) => Effect.logWarning(`git detect failed for ${w.path}: ${e}`)),
            )
          },
          { concurrency: 4, discard: true },
        ),
      ),
      Effect.forkScoped,
    )

    const status = (workspaceId: string): Effect.Effect<GitStatus, ArcRequestError> =>
      Effect.gen(function* () {
          const workspace = resolveWorkspace(yield* workspaces.list, workspaceId)
          if (!workspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))

          const isRepoResult = yield* Effect.promise(() =>
            runGit(workspace.path, ["rev-parse", "--is-inside-work-tree"]),
          )
          const isRepo = isRepoResult.stdout.trim() === "true"
          if (!isRepo) {
            return {
              workspaceId,
              workspaceName: workspace.name,
              isRepo: false,
              changes: [],
            }
          }

          const [branch, head, rawStatus, stats] = yield* Effect.promise(async () =>
            Promise.all([
              runGit(workspace.path, ["branch", "--show-current"]),
              runGit(workspace.path, ["rev-parse", "HEAD"]),
              runGit(workspace.path, ["status", "--porcelain", "-uall"]),
              trackedStats(workspace.path),
            ]),
          )
          const parsed = rawStatus.stdout
            .split("\n")
            .map(parseStatusLine)
            .filter((change): change is GitFileChange => change !== undefined)
          const enriched = yield* Effect.promise(async () =>
            Promise.all(
              parsed.map(async (change) => {
                const stat =
                  change.status === "untracked"
                    ? await untrackedStat(workspace.path, change.path)
                    : stats.get(change.path)
                return stat ? { ...change, ...stat } : change
              }),
            ),
          )

          return {
            workspaceId,
            workspaceName: workspace.name,
            branch: trimmedOrUndefined(branch.stdout),
            head: trimmedOrUndefined(head.stdout),
            isRepo: true,
            changes: enriched.sort((a, b) => {
              const order = statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
              return order === 0 ? a.path.localeCompare(b.path) : order
            }),
          }
        })

    const commits = (
      workspaceId: string,
      limit = 50,
    ): Effect.Effect<ReadonlyArray<GitCommit>, ArcRequestError> =>
      Effect.gen(function* () {
        const workspace = resolveWorkspace(yield* workspaces.list, workspaceId)
        if (!workspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))

        // Scope the log to this branch's own commits — everything reachable from
        // HEAD but not from the repo's default branch (`base..HEAD`). On the default
        // branch itself, or when the base ref can't be resolved, fall back to full
        // history so the pane is never mysteriously empty. Branch + default branch
        // come from the cached workspace DTO (populated by repo detection elsewhere),
        // so the history read costs one `git log` and never triggers detection.
        const repository = workspace.repositoryId
          ? yield* store
              .repositoryById(workspace.repositoryId)
              .pipe(Effect.mapError((e) => arcRequestError(`repository load failed: ${e}`)))
          : null
        const remotes = repository ? parseRemotesJson(repository.remotesJson) : []
        const baseRemote = defaultBranchRemote(remotes, repository?.githubOwner ? githubIdentity(remotes) : null)
        const range = yield* Effect.promise(() =>
          resolveBranchRange(workspace.path, workspace.branch ?? undefined, workspace.defaultBranch, baseRemote),
        )

        // One commit per line; fields split by US (0x1f), which never appears in a
        // subject. `--no-show-signature` keeps GPG output off the stream.
        const result = yield* Effect.promise(() =>
          runGit(workspace.path, [
            "log",
            "--no-show-signature",
            `--max-count=${Math.max(1, Math.trunc(limit))}`,
            "--pretty=format:%H%x1f%h%x1f%an%x1f%aI%x1f%s",
            ...range,
          ]),
        )
        // Non-zero exit is the normal "not a repo" / "unborn branch" case — return
        // an empty history rather than surfacing an error to the pane.
        if (result.exitCode !== 0) return []
        return result.stdout
          .split("\n")
          .map((line) => line.split("\x1f"))
          .filter((parts): parts is [string, string, string, string, string] => parts.length === 5 && parts[0] !== "")
          .map(([sha, shortSha, author, authoredAt, subject]) => ({ sha, shortSha, author, authoredAt, subject }))
      }).pipe(Effect.withSpan("arc.git.commits", { attributes: { "arc.workspace_id": workspaceId } }))

    // A git hook runs with cwd = the worktree root. Refresh every workspace that
    // sits in that worktree — its own cwd is the root or a subdirectory of it.
    const workspacesUnderCwd = (
      list: ReadonlyArray<Workspace>,
      cwd: string,
    ): ReadonlyArray<Workspace> => {
      const root = cwd.endsWith(path.sep) ? cwd.slice(0, -1) : cwd
      return list.filter((w) => w.path === root || w.path.startsWith(root + path.sep))
    }

    const notifyCheckout = (cwd: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const targets = workspacesUnderCwd(yield* workspaces.list, cwd)
        yield* Effect.forEach(
          targets,
          (w) =>
            detectRepository(w.id).pipe(
              Effect.flatMap(() => publishChange(w.id)),
              Effect.catch((e) => Effect.logWarning(`git checkout refresh failed for ${w.path}: ${e}`)),
            ),
          { concurrency: 4, discard: true },
        )
      }).pipe(Effect.withSpan("arc.git.notify_checkout", { attributes: { "arc.cwd": cwd } }))

    // Per-workspace pending PR sync. A push fires `pre-push` before the network
    // round-trip, so GitHub is stale now; we wait, then sync. A second push for
    // the same workspace interrupts the prior pending sync (debounce, latest
    // wins). Entries are overwritten in place — a finished fiber left in the map
    // is inert, so no cleanup pass is needed.
    const pendingSync = new Map<string, Fiber.Fiber<void, never>>()
    const PUSH_SYNC_DELAY = Duration.seconds(4)

    const notifyPrePush = (cwd: string): Effect.Effect<void> =>
      Effect.gen(function* () {
        const targets = workspacesUnderCwd(yield* workspaces.list, cwd)
        yield* Effect.forEach(
          targets,
          (w) =>
            Effect.gen(function* () {
              const existing = pendingSync.get(w.id)
              if (existing) yield* Fiber.interrupt(existing)
              const fiber = yield* Effect.sleep(PUSH_SYNC_DELAY).pipe(
                Effect.flatMap(() => syncPullRequests(w.id)),
                // A deliberate push is the right moment to reap worktrees whose PR
                // just merged — unlike the passive open-sync, which must never
                // delete trees. Best-effort; failures here are swallowed below.
                Effect.flatMap(() => pruneMergedWorktrees(w.id)),
                Effect.flatMap(() => publishChange(w.id)),
                Effect.asVoid,
                Effect.catch((e) => Effect.logWarning(`git push PR sync failed for ${w.path}: ${e}`)),
                Effect.forkIn(scope),
              )
              pendingSync.set(w.id, fiber)
            }),
          { discard: true },
        )
      }).pipe(Effect.withSpan("arc.git.notify_pre_push", { attributes: { "arc.cwd": cwd } }))

    // --- Worktree lifecycle (create / open / remove / prune) + PR creation. ---

    const profile = resolveProfile()
    const managedWorktreesRoot = arcWorkWorktreesDir(profile)

    const requireRepository = (workspaceId: string): Effect.Effect<RepositoryRow, ArcRequestError> =>
      detectRepository(workspaceId).pipe(
        Effect.flatMap((repo) =>
          repo
            ? Effect.succeed(repo)
            : Effect.fail(arcRequestError(`Workspace ${workspaceId} is not in a git repository`)),
        ),
      )

    // The slug arc files a managed worktree under: the GitHub repo name when we
    // have one, else the clone's directory name.
    const repoSlugFor = (repo: RepositoryRow): string => repo.githubRepo ?? path.basename(repo.rootPath)

    // git reports symlink-resolved paths (e.g. /private/var on macOS) while the
    // managed root is derived from os.homedir(); canonicalize both before the
    // prefix check, or a symlinked home would read as "not arc-managed".
    const canonical = (p: string): string => {
      try {
        return realpathSync(p)
      } catch {
        return path.resolve(p)
      }
    }
    const isManaged = (worktreePath: string): boolean =>
      canonical(worktreePath).startsWith(canonical(managedWorktreesRoot) + path.sep)

    const createWorktree = (
      workspaceId: string,
      options: { readonly branch: string; readonly baseRef?: string; readonly createBranch?: boolean },
    ): Effect.Effect<WorktreeRow, ArcRequestError> =>
      Effect.gen(function* () {
        const repo = yield* requireRepository(workspaceId)
        const dest = arcWorkWorktreePath(profile, repoSlugFor(repo), options.branch)
        // `git worktree add` creates the leaf dir; ensure the repo-slug parent exists.
        yield* Effect.tryPromise({
          try: () => fs.mkdir(path.dirname(dest), { recursive: true }),
          catch: (e) => arcRequestError(`worktree dir create failed: ${e}`),
        })
        const args = options.createBranch
          ? ["worktree", "add", "-b", options.branch, dest, options.baseRef ?? repo.defaultBranch ?? "HEAD"]
          : ["worktree", "add", dest, options.branch]
        const result = yield* Effect.promise(() => runGitCapture(repo.rootPath, args))
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            arcRequestError(`git worktree add failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`),
          )
        }
        // detectRepository re-enumerates every worktree under the common git dir,
        // so the new tree lands in the read model; read it back to return its row.
        yield* detectRepository(workspaceId)
        const rows = yield* store
          .loadWorktreesForRepository(repo.id)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
        // Match on branch, not path: git reports the canonical (symlink-resolved)
        // path, which can differ from `dest` (e.g. /private/var vs /var on macOS),
        // and a branch is checked out in at most one worktree.
        const created = rows.find((w) => w.branch === options.branch)
        if (!created) return yield* Effect.fail(arcRequestError(`worktree created but not found for ${options.branch}`))
        yield* publishChange(workspaceId)
        return created
      }).pipe(Effect.withSpan("arc.git.create_worktree", { attributes: { "arc.workspace_id": workspaceId } }))

    const openWorktree = (worktreePath: string): Effect.Effect<Workspace, ArcRequestError> =>
      Effect.gen(function* () {
        const workspace = yield* workspaces
          .openAt(worktreePath)
          .pipe(Effect.mapError((e) => arcRequestError(`open worktree failed: ${e}`)))
        yield* detectRepository(workspace.id)
        yield* publishChange(workspace.id)
        return workspace
      }).pipe(Effect.withSpan("arc.git.open_worktree", { attributes: { "arc.worktree_path": worktreePath } }))

    const removeWorktree = (
      workspaceId: string,
      worktreePath: string,
      options?: { readonly force?: boolean },
    ): Effect.Effect<void, ArcRequestError> =>
      Effect.gen(function* () {
        const repo = yield* requireRepository(workspaceId)
        if (path.resolve(worktreePath) === path.resolve(repo.rootPath)) {
          return yield* Effect.fail(arcRequestError("Refusing to remove the main worktree"))
        }
        const args = ["worktree", "remove", ...(options?.force ? ["--force"] : []), worktreePath]
        const result = yield* Effect.promise(() => runGitCapture(repo.rootPath, args))
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            arcRequestError(`git worktree remove failed: ${result.stderr.trim() || `exit ${result.exitCode}`}`),
          )
        }
        yield* store
          .deleteWorktreeByPath(worktreePath)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree row delete failed: ${e}`)))
        yield* publishChange(workspaceId)
      }).pipe(Effect.withSpan("arc.git.remove_worktree", { attributes: { "arc.workspace_id": workspaceId } }))

    const pruneWorktrees = (workspaceId: string): Effect.Effect<number, ArcRequestError> =>
      Effect.gen(function* () {
        const repo = yield* requireRepository(workspaceId)
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
        const persisted = yield* store
          .loadWorktreesForRepository(repo.id)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
        let removed = 0
        for (const row of persisted) {
          if (livePaths.has(path.resolve(row.path))) continue
          yield* store
            .deleteWorktreeByPath(row.path)
            .pipe(Effect.mapError((e) => arcRequestError(`worktree row delete failed: ${e}`)))
          removed++
        }
        if (removed > 0) yield* publishChange(workspaceId)
        return removed
      }).pipe(Effect.withSpan("arc.git.prune_worktrees", { attributes: { "arc.workspace_id": workspaceId } }))

    const pruneMergedWorktrees = (
      workspaceId: string,
    ): Effect.Effect<ReadonlyArray<string>, ArcRequestError> =>
      Effect.gen(function* () {
        const repo = yield* requireRepository(workspaceId)
        const worktrees = yield* store
          .loadWorktreesForRepository(repo.id)
          .pipe(Effect.mapError((e) => arcRequestError(`worktree load failed: ${e}`)))
        const prs = yield* store
          .loadPullRequestsForRepository(repo.id)
          .pipe(Effect.mapError((e) => arcRequestError(`PR load failed: ${e}`)))
        const mergedBranches = new Set(prs.filter((pr) => pr.state === "merged").map((pr) => pr.headRef))

        const pruned: Array<string> = []
        for (const wt of worktrees) {
          if (!wt.branch || !mergedBranches.has(wt.branch)) continue
          if (path.resolve(wt.path) === path.resolve(repo.rootPath)) continue
          // Only ever auto-delete trees arc created and owns — never a user's.
          if (!isManaged(wt.path)) {
            yield* Effect.logDebug(`auto-prune skip (not arc-managed): ${wt.path}`)
            continue
          }
          const dirty = (yield* Effect.promise(() => runGit(wt.path, ["status", "--porcelain"]))).stdout.trim()
          if (dirty.length > 0) {
            yield* Effect.logInfo(`auto-prune skip (uncommitted changes): ${wt.path}`)
            continue
          }
          const result = yield* Effect.promise(() =>
            runGitCapture(repo.rootPath, ["worktree", "remove", wt.path]),
          )
          if (result.exitCode !== 0) {
            yield* Effect.logWarning(`auto-prune failed for ${wt.path}: ${result.stderr.trim() || `exit ${result.exitCode}`}`)
            continue
          }
          yield* store
            .deleteWorktreeByPath(wt.path)
            .pipe(Effect.mapError((e) => arcRequestError(`worktree row delete failed: ${e}`)))
          yield* Effect.logInfo(`auto-pruned merged worktree: ${wt.path}`)
          pruned.push(wt.path)
        }
        if (pruned.length > 0) yield* publishChange(workspaceId)
        return pruned
      }).pipe(Effect.withSpan("arc.git.prune_merged_worktrees", { attributes: { "arc.workspace_id": workspaceId } }))

    const createPullRequest = (
      workspaceId: string,
      options: {
        readonly title?: string
        readonly body?: string
        readonly base?: string
        readonly draft?: boolean
      },
    ): Effect.Effect<PullRequestRow | null, ArcRequestError> =>
      Effect.gen(function* () {
        const repo = yield* requireRepository(workspaceId)
        if (!repo.githubOwner || !repo.githubRepo) {
          return yield* Effect.fail(arcRequestError("No GitHub remote for this repository"))
        }
        const workspace = resolveWorkspace(yield* workspaces.list, workspaceId)
        if (!workspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))
        const branch = (
          yield* Effect.promise(() => runGit(workspace.path, ["rev-parse", "--abbrev-ref", "HEAD"]))
        ).stdout.trim()
        if (!branch || branch === "HEAD") {
          return yield* Effect.fail(arcRequestError("Cannot open a PR from a detached HEAD"))
        }
        const base = options.base ?? repo.defaultBranch ?? "main"
        const slug = `${repo.githubOwner}/${repo.githubRepo}`
        const args = [
          "pr",
          "create",
          "--repo",
          slug,
          "--base",
          base,
          "--head",
          branch,
          ...(options.draft ? ["--draft"] : []),
          ...(options.title ? ["--title", options.title] : []),
          ...(options.body !== undefined ? ["--body", options.body] : []),
          // No explicit title → let gh fill title/body from the branch's commits.
          ...(options.title ? [] : ["--fill"]),
        ]
        const result = yield* Effect.promise(() => runGh(workspace.path, args))
        if (result.exitCode !== 0) {
          return yield* Effect.fail(
            arcRequestError(`gh pr create failed (exit ${result.exitCode}) — branch may be unpushed or a PR may already exist`),
          )
        }
        // Pull the freshly opened PR into the read model and return its row.
        const synced = yield* syncPullRequests(workspaceId)
        yield* publishChange(workspaceId)
        return synced.find((pr) => pr.headRef === branch) ?? null
      }).pipe(Effect.withSpan("arc.git.create_pull_request", { attributes: { "arc.workspace_id": workspaceId } }))

    return GitService.of({
      status,
      commits,
      detectRepository,
      syncPullRequests,
      gitContext,
      createWorktree,
      openWorktree,
      removeWorktree,
      pruneWorktrees,
      pruneMergedWorktrees,
      createPullRequest,
      changes,
      notifyCheckout,
      notifyPrePush,
      diff: (workspaceId, filePath) =>
        Effect.gen(function* () {
          const workspace = resolveWorkspace(yield* workspaces.list, workspaceId)
          if (!workspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))
          const gitStatus = yield* status(workspaceId)
          const change = gitStatus.changes.find((candidate) => candidate.path === filePath)
          if (!change) return { path: filePath, diff: "" }
          if (change.isBinary) return { path: filePath, diff: "Binary file - no diff available" }

          const args =
            change.status === "untracked"
              ? ["diff", "--no-index", "--", "/dev/null", change.path]
              : [
                  "diff",
                  "HEAD",
                  "-M",
                  "--",
                  ...(change.originalPath ? [change.originalPath] : []),
                  change.path,
                ]
          const result = yield* Effect.promise(() => runGit(workspace.path, args))
          if (result.stdout.length > 0) return { path: filePath, diff: result.stdout }
          const fallback = yield* Effect.promise(() => runGit(workspace.path, ["diff", "-M", "--", change.path]))
          return { path: filePath, diff: fallback.stdout || "(no diff available)" }
        }),
    })
  }),
)
