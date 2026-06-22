import type { PullRequestRow, RepositoryRow, WorktreeRow } from "../../db/schema.js"
import type { PrState, PullRequest, Repository, Worktree } from "../../../shared/git.js"
import { toPrState } from "../../../shared/git.js"
import type { PrId, RepositoryId } from "../../../shared/ids.js"
import { bool, type GhPullRequest, lowerOrNull, summarizeChecks } from "./parse.js"

/** Normalize a `gh pr list` record into a PullRequestRow. GitHub's createdAt/
 * updatedAt are preserved as the row's lifecycle timestamps (upsert keeps
 * created_at, refreshes updated_at), with `lastSyncedAt` stamping this sync.
 * Enums are lowercased; blank review/mergeable/state values become null. */
export const mapGhPullRequest = (
  repositoryId: RepositoryId,
  id: PrId,
  raw: GhPullRequest,
  now: string,
): PullRequestRow => ({
  id,
  repositoryId,
  number: raw.number,
  githubNodeId: raw.id ?? null,
  title: raw.title ?? "",
  body: raw.body ?? "",
  state: lowerOrNull(raw.state) ?? "open",
  isDraft: bool(raw.isDraft === true),
  author: raw.author?.login ?? null,
  headRef: raw.headRefName ?? "",
  headSha: raw.headRefOid ?? null,
  headRepositoryOwner: raw.headRepositoryOwner?.login ?? null,
  headRepositoryName: raw.headRepository?.name ?? null,
  baseRef: raw.baseRefName ?? "",
  reviewState: lowerOrNull(raw.reviewDecision),
  checksState: summarizeChecks(raw.statusCheckRollup),
  mergeable: lowerOrNull(raw.mergeable === "UNKNOWN" ? null : raw.mergeable),
  mergeStateStatus: lowerOrNull(raw.mergeStateStatus === "UNKNOWN" ? null : raw.mergeStateStatus),
  url: raw.url ?? null,
  lastSyncedAt: now,
  createdAt: raw.createdAt ?? now,
  updatedAt: raw.updatedAt ?? now,
})

/** Project the persisted rows onto the renderer wire shapes (see shared/git.ts).
 * The DB stores booleans as 0/1; the wire carries real booleans. */
export const toWireRepository = (row: RepositoryRow): Repository => ({
  id: row.id,
  rootPath: row.rootPath,
  defaultBranch: row.defaultBranch,
  githubOwner: row.githubOwner,
  githubRepo: row.githubRepo,
})

export const toWireWorktree = (row: WorktreeRow): Worktree => ({
  id: row.id,
  path: row.path,
  branch: row.branch,
  headSha: row.headSha,
  isDetached: row.isDetached === 1,
  isLocked: row.isLocked === 1,
  isPrunable: row.isPrunable === 1,
})

// The PR's `state` is stored as a free-form column but the wire narrows it to
// the closed `PrState` union — the one place that coercion happens, so the
// renderer never re-validates per call site.
const wirePrState = (state: string): PrState => toPrState(state) ?? "open"

export const toWirePullRequest = (row: PullRequestRow): PullRequest => ({
  id: row.id,
  number: row.number,
  title: row.title,
  state: wirePrState(row.state),
  isDraft: row.isDraft === 1,
  author: row.author,
  headRef: row.headRef,
  baseRef: row.baseRef,
  reviewState: row.reviewState,
  checksState: row.checksState,
  mergeable: row.mergeable,
  url: row.url,
  updatedAt: row.updatedAt,
})
