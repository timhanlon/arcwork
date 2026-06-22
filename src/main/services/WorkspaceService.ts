import { Context, Effect, Layer, type Stream, SubscriptionRef } from "effect"
import { dialog } from "electron"
import * as path from "node:path"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Workspace, WorkspacePullRequest } from "../../shared/workspace.js"
import { toPrState } from "../../shared/git.js"
import { ArcStore } from "../db/store.js"
import type { PullRequestRow, RepositoryRow, WorkspaceRow } from "../db/schema.js"
import { newArcId } from "../../shared/ids.js"
import { nowIso } from "../clock.js"

/** Project header label: `owner/repo` when GitHub identity is known, else the
 * repo root's basename. Null for a workspace with no repository. */
const repoLabel = (repo: RepositoryRow | undefined): string | null => {
  if (!repo) return null
  if (repo.githubOwner && repo.githubRepo) return `${repo.githubOwner}/${repo.githubRepo}`
  return path.basename(repo.rootPath)
}

/** The `(repositoryId, headRef)` key used to find a workspace's branch PR. */
const prKey = (repositoryId: string, headRef: string): string => `${repositoryId}\n${headRef}`

const toWorkspacePullRequest = (row: PullRequestRow): WorkspacePullRequest => ({
  number: row.number,
  title: row.title,
  state: toPrState(row.state) ?? "open",
  isDraft: row.isDraft === 1,
  url: row.url,
})

/**
 * Owns the persisted workspace list — filesystem roots that scope chats and
 * supply cwd for launched targets. Multiple workspaces are visible concurrently;
 * there is no single "active" workspace.
 */
export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly list: Effect.Effect<ReadonlyArray<Workspace>>
    readonly changes: Stream.Stream<ReadonlyArray<Workspace>>
    readonly open: Effect.Effect<Workspace | undefined, SqlError>
    /** Register (or refresh) a workspace at an explicit directory — the no-dialog
     * sibling of {@link open}, used to open an arc-created worktree as a
     * workspace. Idempotent on path. */
    readonly openAt: (dir: string) => Effect.Effect<Workspace, SqlError>
    /** Re-project the list from the DB. Git detection writes repo/branch onto
     * the workspace rows after they first appear, so the owner of that write
     * ({@link GitService}) calls this to push the enriched rows to subscribers. */
    readonly refresh: Effect.Effect<void>
  }
>()("WorkspaceService") {}

export const rowToWorkspace = (
  row: WorkspaceRow,
  repoById: ReadonlyMap<string, RepositoryRow>,
  prByBranch: ReadonlyMap<string, WorkspacePullRequest> = new Map(),
): Workspace => {
  const repo = row.repositoryId ? repoById.get(row.repositoryId) : undefined
  return {
    id: row.id,
    path: row.path,
    name: row.name,
    repositoryId: row.repositoryId,
    repoLabel: repoLabel(repo),
    defaultBranch: repo?.defaultBranch ?? null,
    branch: row.gitBranch,
    // The main checkout lives at the repo root; anything else under the repo is
    // a linked worktree.
    isWorktree: repo !== undefined && row.path !== repo.rootPath,
    pullRequest:
      row.repositoryId && row.gitBranch
        ? prByBranch.get(prKey(row.repositoryId, row.gitBranch)) ?? null
        : null,
  }
}

export const WorkspaceServiceLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const db = yield* ArcStore

    const loadRepoMap = db.loadRepositories.pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<RepositoryRow>),
      Effect.map((repos) => new Map(repos.map((repo) => [repo.id, repo] as const))),
    )

    const loadPrMap = db.loadSidebarPullRequests.pipe(
      Effect.orElseSucceed(() => [] as ReadonlyArray<PullRequestRow>),
      Effect.map((rows) => {
        // Keyed `(repositoryId, headRef)`; rows arrive open-first then by descending
        // number, so the first seen for a branch wins — an open PR over a merged
        // one, the newest among ties.
        const map = new Map<string, WorkspacePullRequest>()
        for (const row of rows) {
          const key = prKey(row.repositoryId, row.headRef)
          if (!map.has(key)) map.set(key, toWorkspacePullRequest(row))
        }
        return map
      }),
    )

    const loadProjected = Effect.gen(function* () {
      const [wsRows, repoById, prByBranch] = yield* Effect.all([
        db.loadWorkspaces.pipe(
          Effect.tapError((e) => Effect.logWarning(`workspace load failed; starting empty: ${e}`)),
          Effect.orElseSucceed(() => [] as ReadonlyArray<WorkspaceRow>),
        ),
        loadRepoMap,
        loadPrMap,
      ])
      return wsRows.map((row) => rowToWorkspace(row, repoById, prByBranch))
    })

    const store = yield* SubscriptionRef.make(yield* loadProjected)

    const refresh = loadProjected.pipe(Effect.flatMap((next) => SubscriptionRef.set(store, next)))

    const upsertByPath = Effect.fn("WorkspaceService.upsertByPath")((dir: string) =>
      Effect.gen(function* () {
        const resolved = path.resolve(dir)
        const now = yield* nowIso
        const row = yield* db.upsertWorkspace({
          id: newArcId("workspace"),
          path: resolved,
          name: path.basename(resolved),
          createdAt: now,
          lastOpenedAt: now,
        })
        yield* refresh
        return rowToWorkspace(row, yield* loadRepoMap)
      }).pipe(
        Effect.withSpan("arc.workspace.upsert", {
          attributes: {
            "arc.workspace_path": path.resolve(dir),
          },
        }),
      ),
    )

    const list = SubscriptionRef.get(store)
    const changes = SubscriptionRef.changes(store)

    const open = Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        }),
      )
      if (result.canceled || result.filePaths.length === 0) return undefined
      return yield* upsertByPath(result.filePaths[0]!)
    }).pipe(Effect.withSpan("arc.workspace.open_dialog"))

    return { list, changes, open, openAt: upsertByPath, refresh }
  }),
)
