import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { PullRequestRow, RepositoryRow, WorktreeRow } from "../schema.js"

/** The git/github read-model slice of {@link ArcStore} — repository, worktree,
 * and pull-request persistence, plus the workspace git-binding write. */
export interface GitStore {
  readonly loadRepositories: Effect.Effect<ReadonlyArray<RepositoryRow>, SqlError>
  /** Upsert a repository keyed by its common git dir; refreshes identity +
   * last-seen, preserving the row's id. Returns the canonical row. */
  readonly upsertRepository: (row: RepositoryRow) => Effect.Effect<RepositoryRow, SqlError>
  readonly repositoryByCommonGitDir: (
    commonGitDir: string,
  ) => Effect.Effect<RepositoryRow | null, SqlError>
  readonly repositoryById: (id: string) => Effect.Effect<RepositoryRow | null, SqlError>
  readonly loadWorktreesForRepository: (
    repositoryId: string,
  ) => Effect.Effect<ReadonlyArray<WorktreeRow>, SqlError>
  /** Upsert a worktree keyed by its path; returns the canonical row. */
  readonly upsertWorktree: (row: WorktreeRow) => Effect.Effect<WorktreeRow, SqlError>
  readonly deleteWorktreeByPath: (path: string) => Effect.Effect<boolean, SqlError>
  /** Head-ref names of merged PRs whose head lives in this repository (fork-safe;
   * see {@link headInRepository}) — the input to auto-pruning a merged worktree. */
  readonly mergedBranchesForRepository: (
    repositoryId: string,
  ) => Effect.Effect<ReadonlyArray<string>, SqlError>
  /** Every open or merged PR across all repositories — the source for the
   * sidebar's per-workspace branch→PR chip, joined in one read rather than per
   * row. Open PRs sort first so a branch with both shows the open one (drafts
   * are open, so they ride along here). */
  readonly loadSidebarPullRequests: Effect.Effect<ReadonlyArray<PullRequestRow>, SqlError>
  /** Upsert a PR keyed `(repositoryId, number)`; returns the canonical row. */
  readonly upsertPullRequest: (row: PullRequestRow) => Effect.Effect<PullRequestRow, SqlError>
  /** The branch→PR map: the open PR whose head ref matches `headRef` in the
   * repo, preferring open over closed/merged, newest first. Null when none. */
  readonly pullRequestForBranch: (
    repositoryId: string,
    headRef: string,
  ) => Effect.Effect<PullRequestRow | null, SqlError>
  /** Bind a workspace into the git domain and cache its cwd snapshot. Each
   * field is left untouched when the argument is `undefined`. */
  readonly setWorkspaceGit: (
    workspaceId: string,
    git: {
      readonly repositoryId?: string | null
      readonly worktreeId?: string | null
      readonly gitBranch?: string | null
      readonly gitHeadSha?: string | null
    },
  ) => Effect.Effect<void, SqlError>
}

/** Build the git/github read-model query closures over a SQL client. Composed
 * into {@link ArcStoreLive}; the persisted rows are projected onto the renderer
 * wire shapes in services/git/wire.ts. */
export const makeGitStore = (sql: SqlClient): GitStore => {
  const loadRepositories =
    sql<RepositoryRow>`SELECT * FROM repositories ORDER BY last_seen_at DESC, id`

  const upsertRepository = (row: RepositoryRow) =>
    Effect.gen(function* () {
      const rows = yield* sql<RepositoryRow>`INSERT INTO repositories ${sql.insert({
        id: row.id,
        commonGitDir: row.commonGitDir,
        rootPath: row.rootPath,
        defaultBranch: row.defaultBranch,
        remotesJson: row.remotesJson,
        githubOwner: row.githubOwner,
        githubRepo: row.githubRepo,
        githubNodeId: row.githubNodeId,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
      })} ON CONFLICT(common_git_dir) DO UPDATE SET
        root_path = excluded.root_path,
        default_branch = excluded.default_branch,
        remotes_json = excluded.remotes_json,
        github_owner = excluded.github_owner,
        github_repo = excluded.github_repo,
        github_node_id = excluded.github_node_id,
        last_seen_at = excluded.last_seen_at
        RETURNING *`
      const canonical = rows[0]
      if (!canonical) {
        return yield* Effect.die(new Error(`repository upsert left no row for ${row.commonGitDir}`))
      }
      return canonical
    })

  const repositoryByCommonGitDir = (commonGitDir: string) =>
    sql<RepositoryRow>`SELECT * FROM repositories WHERE common_git_dir = ${commonGitDir} LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    )

  const repositoryById = (id: string) =>
    sql<RepositoryRow>`SELECT * FROM repositories WHERE id = ${id} LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    )

  const loadWorktreesForRepository = (repositoryId: string) =>
    sql<WorktreeRow>`SELECT * FROM worktrees
      WHERE repository_id = ${repositoryId}
      ORDER BY path`

  const upsertWorktree = (row: WorktreeRow) =>
    Effect.gen(function* () {
      const rows = yield* sql<WorktreeRow>`INSERT INTO worktrees ${sql.insert({
        id: row.id,
        repositoryId: row.repositoryId,
        path: row.path,
        branch: row.branch,
        headSha: row.headSha,
        isDetached: row.isDetached,
        isBare: row.isBare,
        isLocked: row.isLocked,
        lockedReason: row.lockedReason,
        isPrunable: row.isPrunable,
        prunableReason: row.prunableReason,
        createdAt: row.createdAt,
        lastSeenAt: row.lastSeenAt,
      })} ON CONFLICT(path) DO UPDATE SET
        repository_id = excluded.repository_id,
        branch = excluded.branch,
        head_sha = excluded.head_sha,
        is_detached = excluded.is_detached,
        is_bare = excluded.is_bare,
        is_locked = excluded.is_locked,
        locked_reason = excluded.locked_reason,
        is_prunable = excluded.is_prunable,
        prunable_reason = excluded.prunable_reason,
        last_seen_at = excluded.last_seen_at
        RETURNING *`
      const canonical = rows[0]
      if (!canonical) {
        return yield* Effect.die(new Error(`worktree upsert left no row for ${row.path}`))
      }
      return canonical
    })

  const deleteWorktreeByPath = (path: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM worktrees WHERE path = ${path}`
        const rows = yield* sql<{ changes: number }>`SELECT changes() AS changes`
        return (rows[0]?.changes ?? 0) > 0
      }),
    )

  // The branch→PR invariant, in one place. A PR maps onto a local branch only
  // when its head lives in the repository itself, not a fork that reused the
  // branch name — `head_ref` is just a branch name. The owner/name equality also
  // drops rows with a NULL head repo (synced before the column existed), whose
  // safe default is to surface no PR rather than a possible fork's. Every query
  // that joins a PR to a local branch composes this fragment over `pr`/`r`.
  const headInRepository = sql`pr.head_repository_owner = r.github_owner
    AND pr.head_repository_name = r.github_repo`

  const mergedBranchesForRepository = (repositoryId: string) =>
    sql<{ headRef: string }>`SELECT DISTINCT pr.head_ref FROM pull_requests pr
      JOIN repositories r ON r.id = pr.repository_id
      WHERE pr.repository_id = ${repositoryId} AND pr.state = 'merged'
        AND ${headInRepository}`.pipe(Effect.map((rows) => rows.map((row) => row.headRef)))

  // Open PRs sort first so a branch with both shows the open one.
  const loadSidebarPullRequests = sql<PullRequestRow>`SELECT pr.* FROM pull_requests pr
    JOIN repositories r ON r.id = pr.repository_id
    WHERE pr.state IN ('open', 'merged') AND ${headInRepository}
    ORDER BY (pr.state = 'open') DESC, pr.number DESC`

  const upsertPullRequest = (row: PullRequestRow) =>
    Effect.gen(function* () {
      const rows = yield* sql<PullRequestRow>`INSERT INTO pull_requests ${sql.insert({
        id: row.id,
        repositoryId: row.repositoryId,
        number: row.number,
        githubNodeId: row.githubNodeId,
        title: row.title,
        body: row.body,
        state: row.state,
        isDraft: row.isDraft,
        author: row.author,
        headRef: row.headRef,
        headSha: row.headSha,
        headRepositoryOwner: row.headRepositoryOwner,
        headRepositoryName: row.headRepositoryName,
        baseRef: row.baseRef,
        reviewState: row.reviewState,
        checksState: row.checksState,
        mergeable: row.mergeable,
        mergeStateStatus: row.mergeStateStatus,
        url: row.url,
        lastSyncedAt: row.lastSyncedAt,
        createdAt: row.createdAt,
        updatedAt: row.updatedAt,
      })} ON CONFLICT(repository_id, number) DO UPDATE SET
        github_node_id = excluded.github_node_id,
        title = excluded.title,
        body = excluded.body,
        state = excluded.state,
        is_draft = excluded.is_draft,
        author = excluded.author,
        head_ref = excluded.head_ref,
        head_sha = excluded.head_sha,
        head_repository_owner = excluded.head_repository_owner,
        head_repository_name = excluded.head_repository_name,
        base_ref = excluded.base_ref,
        review_state = excluded.review_state,
        checks_state = excluded.checks_state,
        mergeable = excluded.mergeable,
        merge_state_status = excluded.merge_state_status,
        url = excluded.url,
        last_synced_at = excluded.last_synced_at,
        updated_at = excluded.updated_at
        RETURNING *`
      const canonical = rows[0]
      if (!canonical) {
        return yield* Effect.die(
          new Error(`pull request upsert left no row for ${row.repositoryId}#${row.number}`),
        )
      }
      return canonical
    })

  // Prefer an open PR; among same state, the most recently synced. `state` is
  // GitHub's literal ('open'|'closed'|'merged'), so ordering open first is an
  // explicit predicate rather than a lexical sort. Fork-safe via headInRepository.
  const pullRequestForBranch = (repositoryId: string, headRef: string) =>
    sql<PullRequestRow>`SELECT pr.* FROM pull_requests pr
      JOIN repositories r ON r.id = pr.repository_id
      WHERE pr.repository_id = ${repositoryId} AND pr.head_ref = ${headRef}
        AND ${headInRepository}
      ORDER BY (pr.state = 'open') DESC, pr.last_synced_at DESC, pr.number DESC
      LIMIT 1`.pipe(Effect.map((rows) => rows[0] ?? null))

  const setWorkspaceGit = (
    workspaceId: string,
    git: {
      readonly repositoryId?: string | null
      readonly worktreeId?: string | null
      readonly gitBranch?: string | null
      readonly gitHeadSha?: string | null
    },
  ) => {
    // Assign only the columns whose argument was supplied: an explicit null
    // clears (COALESCE couldn't), an omitted field is left untouched. Building
    // the SET list from the present keys keeps each column one bound assignment.
    const sets = []
    if (git.repositoryId !== undefined) sets.push(sql`repository_id = ${git.repositoryId}`)
    if (git.worktreeId !== undefined) sets.push(sql`worktree_id = ${git.worktreeId}`)
    if (git.gitBranch !== undefined) sets.push(sql`git_branch = ${git.gitBranch}`)
    if (git.gitHeadSha !== undefined) sets.push(sql`git_head_sha = ${git.gitHeadSha}`)
    if (sets.length === 0) return Effect.void
    return sql`UPDATE workspaces SET ${sql.csv(sets)} WHERE id = ${workspaceId}`.pipe(Effect.asVoid)
  }

  return {
    loadRepositories,
    upsertRepository,
    repositoryByCommonGitDir,
    repositoryById,
    loadWorktreesForRepository,
    upsertWorktree,
    deleteWorktreeByPath,
    mergedBranchesForRepository,
    loadSidebarPullRequests,
    upsertPullRequest,
    pullRequestForBranch,
    setWorkspaceGit,
  }
}
