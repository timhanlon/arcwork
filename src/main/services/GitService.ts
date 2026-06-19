import { Context, Effect, Layer, Stream } from "effect"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { GitChangeStatus, GitFileChange, GitFileDiff, GitStatus } from "../../shared/git.js"
import type { Workspace } from "../../shared/workspace.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { WorkspaceService } from "./WorkspaceService.js"
import { ArcStore } from "../db/store.js"
import type { PullRequestRow, RepositoryRow } from "../db/schema.js"
import { newArcId } from "../../shared/ids.js"
import { nowIso } from "../clock.js"

export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (workspaceId: string) => Effect.Effect<GitStatus, ArcRequestError>
    readonly diff: (workspaceId: string, filePath: string) => Effect.Effect<GitFileDiff, ArcRequestError>
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
  }
>()("GitService") {}

/** The `gh pr list --json` fields we request, shaped loosely — gh emits
 * uppercase enums and may omit/blank some fields, normalized in {@link mapGhPullRequest}. */
export interface GhPullRequest {
  readonly number: number
  readonly id?: string | null
  readonly title?: string | null
  readonly body?: string | null
  readonly state?: string | null
  readonly isDraft?: boolean | null
  readonly author?: { readonly login?: string | null } | null
  readonly headRefName?: string | null
  readonly headRefOid?: string | null
  readonly baseRefName?: string | null
  readonly reviewDecision?: string | null
  readonly mergeable?: string | null
  readonly mergeStateStatus?: string | null
  readonly url?: string | null
  readonly statusCheckRollup?: ReadonlyArray<Record<string, unknown>> | null
  readonly createdAt?: string | null
  readonly updatedAt?: string | null
}

const GH_PR_FIELDS = [
  "number",
  "id",
  "title",
  "body",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "headRefOid",
  "baseRefName",
  "reviewDecision",
  "mergeable",
  "mergeStateStatus",
  "url",
  "statusCheckRollup",
  "createdAt",
  "updatedAt",
].join(",")

interface GitRemote {
  readonly name: string
  readonly url: string
}

interface WorktreeEntry {
  readonly path: string
  readonly headSha: string | null
  readonly branch: string | null
  readonly isDetached: boolean
  readonly isBare: boolean
  readonly isLocked: boolean
  readonly lockedReason: string | null
  readonly isPrunable: boolean
  readonly prunableReason: string | null
}

interface GitResult {
  readonly stdout: string
  readonly exitCode: number
}

interface LineStat {
  readonly added: number
  readonly deleted: number
  readonly isBinary: boolean
}

const runGit = (cwd: string, args: ReadonlyArray<string>): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        const exitCode =
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? ((error as { code: number }).code)
            : error
              ? 1
              : 0
        resolve({ stdout, exitCode })
      },
    )
  })

const trimmedOrUndefined = (value: string): string | undefined => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

const statusFor = (x: string, y: string): GitChangeStatus => {
  if (x === "?" && y === "?") return "untracked"
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) {
    return "unmerged"
  }
  if (x === "R" || y === "R") return "renamed"
  if (x === "C" || y === "C") return "copied"
  if (x === "A" || y === "A") return "added"
  if (x === "D" || y === "D") return "deleted"
  if (x === "T" || y === "T") return "typeChange"
  if (x === "M" || y === "M") return "modified"
  return "unknown"
}

const unquote = (raw: string): string => {
  const trimmed = raw.trim()
  if (!trimmed.startsWith("\"") || !trimmed.endsWith("\"") || trimmed.length < 2) return trimmed
  return trimmed.slice(1, -1).replace(/\\"/g, "\"").replace(/\\\\/g, "\\")
}

const parseStatusLine = (line: string): GitFileChange | undefined => {
  if (line.length < 3) return undefined
  const x = line[0] ?? " "
  const y = line[1] ?? " "
  const remainder = line.slice(3)
  const [originalPath, filePath] = remainder.includes(" -> ")
    ? (() => {
        const parts = remainder.split(" -> ")
        return [unquote(parts[0] ?? remainder), unquote(parts[parts.length - 1] ?? remainder)]
      })()
    : [undefined, unquote(remainder)]

  return {
    path: filePath,
    originalPath,
    status: statusFor(x, y),
    staged: x !== " " && x !== "?",
    unstaged: y !== " " && y !== "?",
    added: 0,
    deleted: 0,
    isBinary: false,
  }
}

const trackedStats = async (cwd: string): Promise<ReadonlyMap<string, LineStat>> => {
  const result = await runGit(cwd, ["diff", "HEAD", "-M", "--numstat"])
  const stats = new Map<string, LineStat>()
  for (const line of result.stdout.split("\n")) {
    if (!line) continue
    const cols = line.split("\t")
    if (cols.length < 3) continue
    const added = cols[0] ?? "0"
    const deleted = cols[1] ?? "0"
    const isBinary = added === "-" || deleted === "-"
    let filePath = cols.slice(2).join("\t")
    if (filePath.includes(" => ")) filePath = filePath.split(" => ").at(-1) ?? filePath
    stats.set(unquote(filePath), {
      added: Number.parseInt(added, 10) || 0,
      deleted: Number.parseInt(deleted, 10) || 0,
      isBinary,
    })
  }
  return stats
}

const untrackedStat = async (cwd: string, filePath: string): Promise<LineStat> => {
  try {
    const data = await fs.readFile(path.join(cwd, filePath))
    if (data.subarray(0, 8000).includes(0)) return { added: 0, deleted: 0, isBinary: true }
    let lines = 0
    for (const byte of data) if (byte === 0x0a) lines += 1
    if (data.length > 0 && data[data.length - 1] !== 0x0a) lines += 1
    return { added: lines, deleted: 0, isBinary: false }
  } catch {
    return { added: 0, deleted: 0, isBinary: false }
  }
}

const statusOrder: ReadonlyArray<GitChangeStatus> = [
  "added",
  "untracked",
  "modified",
  "typeChange",
  "renamed",
  "copied",
  "deleted",
  "unmerged",
  "unknown",
]

const resolveWorkspace = (workspaces: ReadonlyArray<Workspace>, workspaceId: string): Workspace | undefined =>
  workspaces.find((w) => w.id === workspaceId)

/** Pull `{ owner, repo }` out of a GitHub remote URL in any of the forms git
 * stores — `git@github.com:owner/repo.git`, `https://github.com/owner/repo`,
 * `ssh://git@github.com/owner/repo.git` — with the optional `.git` suffix and
 * trailing slash stripped. Null for non-GitHub hosts (GHES is deferred). */
const parseGithubRemote = (url: string): { owner: string; repo: string } | null => {
  const match = url.match(/github\.com[:/]+([^/]+)\/(.+?)(?:\.git)?\/?$/i)
  if (!match || !match[1] || !match[2]) return null
  return { owner: match[1], repo: match[2] }
}

/** Parse `git remote -v` into one entry per remote (fetch lines), de-duplicated
 * by name and preserving git's output order (so `origin` stays first). */
const parseRemotes = (stdout: string): ReadonlyArray<GitRemote> => {
  const byName = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (match && match[1] && match[2] && !byName.has(match[1])) byName.set(match[1], match[2])
  }
  return [...byName].map(([name, url]) => ({ name, url }))
}

/** Resolve the GitHub owner/repo for a clone: the first remote whose URL is a
 * GitHub URL, preferring `origin`. Null when no remote points at GitHub. */
const githubIdentity = (
  remotes: ReadonlyArray<GitRemote>,
): { owner: string; repo: string } | null => {
  const ordered = [...remotes].sort((a, b) => (a.name === "origin" ? -1 : b.name === "origin" ? 1 : 0))
  for (const remote of ordered) {
    const parsed = parseGithubRemote(remote.url)
    if (parsed) return parsed
  }
  return null
}

/** Parse `git worktree list --porcelain` into one entry per worktree. Records
 * are blank-line separated; a `branch refs/heads/x` line is shortened to `x`,
 * and the boolean attributes (`detached`/`bare`/`locked`/`prunable`) become
 * flags, carrying any trailing reason text. The first record is the main
 * worktree. */
const parseWorktreeList = (stdout: string): ReadonlyArray<WorktreeEntry> => {
  const entries: Array<WorktreeEntry> = []
  let current: {
    path?: string
    headSha?: string
    branch?: string
    isDetached: boolean
    isBare: boolean
    isLocked: boolean
    lockedReason: string | null
    isPrunable: boolean
    prunableReason: string | null
  } | null = null

  const flush = () => {
    if (current?.path) {
      entries.push({
        path: current.path,
        headSha: current.headSha ?? null,
        branch: current.branch ?? null,
        isDetached: current.isDetached,
        isBare: current.isBare,
        isLocked: current.isLocked,
        lockedReason: current.lockedReason,
        isPrunable: current.isPrunable,
        prunableReason: current.prunableReason,
      })
    }
    current = null
  }

  const start = () => ({
    isDetached: false,
    isBare: false,
    isLocked: false,
    lockedReason: null as string | null,
    isPrunable: false,
    prunableReason: null as string | null,
  })

  for (const line of stdout.split("\n")) {
    if (line.trim().length === 0) {
      flush()
      continue
    }
    if (line.startsWith("worktree ")) {
      flush()
      current = { ...start(), path: line.slice("worktree ".length) }
      continue
    }
    if (!current) continue
    if (line.startsWith("HEAD ")) current.headSha = line.slice("HEAD ".length)
    else if (line.startsWith("branch ")) current.branch = line.slice("branch ".length).replace(/^refs\/heads\//, "")
    else if (line === "detached") current.isDetached = true
    else if (line === "bare") current.isBare = true
    else if (line === "locked" || line.startsWith("locked ")) {
      current.isLocked = true
      current.lockedReason = line === "locked" ? null : line.slice("locked ".length)
    } else if (line === "prunable" || line.startsWith("prunable ")) {
      current.isPrunable = true
      current.prunableReason = line === "prunable" ? null : line.slice("prunable ".length)
    }
  }
  flush()
  return entries
}

const bool = (value: boolean): number => (value ? 1 : 0)

const lowerOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase()
  return trimmed && trimmed.length > 0 ? trimmed : null
}

/** Collapse GitHub's `statusCheckRollup` into one verdict: `failing` if any
 * check failed, else `pending` if any is still running, else `passing` if there
 * is at least one check, else null (no checks). Handles both CheckRun
 * (status/conclusion) and legacy StatusContext (state) rollup entries. */
export const summarizeChecks = (
  rollup: ReadonlyArray<Record<string, unknown>> | null | undefined,
): string | null => {
  if (!rollup || rollup.length === 0) return null
  const FAIL_CONCLUSIONS = new Set([
    "FAILURE",
    "ERROR",
    "CANCELLED",
    "TIMED_OUT",
    "ACTION_REQUIRED",
    "STARTUP_FAILURE",
  ])
  let anyFail = false
  let anyPending = false
  for (const entry of rollup) {
    const conclusion = typeof entry["conclusion"] === "string" ? entry["conclusion"] : null
    const statusValue = typeof entry["status"] === "string" ? entry["status"] : null
    const state = typeof entry["state"] === "string" ? entry["state"] : null
    if (conclusion !== null || statusValue !== null) {
      if (conclusion && FAIL_CONCLUSIONS.has(conclusion)) anyFail = true
      else if (statusValue !== "COMPLETED") anyPending = true
    } else if (state !== null) {
      if (state === "FAILURE" || state === "ERROR") anyFail = true
      else if (state !== "SUCCESS") anyPending = true
    }
  }
  return anyFail ? "failing" : anyPending ? "pending" : "passing"
}

/** Normalize a `gh pr list` record into a PullRequestRow. GitHub's createdAt/
 * updatedAt are preserved as the row's lifecycle timestamps (upsert keeps
 * created_at, refreshes updated_at), with `lastSyncedAt` stamping this sync.
 * Enums are lowercased; blank review/mergeable/state values become null. */
export const mapGhPullRequest = (
  repositoryId: string,
  id: string,
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

interface GhResult {
  readonly stdout: string
  readonly exitCode: number
  readonly errored: boolean
}

const runGh = (cwd: string, args: ReadonlyArray<string>): Promise<GhResult> =>
  new Promise((resolve) => {
    execFile("gh", args, { cwd, maxBuffer: 64 * 1024 * 1024 }, (error, stdout) => {
      resolve({
        stdout,
        exitCode:
          typeof (error as { code?: unknown } | null)?.code === "number"
            ? (error as { code: number }).code
            : error
              ? 1
              : 0,
        // A non-numeric code (ENOENT) means gh isn't installed — distinguish it
        // from a normal non-zero exit (e.g. not authenticated) for the log line.
        errored: Boolean(error) && typeof (error as { code?: unknown }).code !== "number",
      })
    })
  })

export const GitServiceLive = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceService
    const store = yield* ArcStore

    const detectRepository = (
      workspaceId: string,
    ): Effect.Effect<RepositoryRow | null, ArcRequestError> =>
      Effect.gen(function* () {
        const workspace = resolveWorkspace(yield* workspaces.list, workspaceId)
        if (!workspace) return yield* Effect.fail(arcRequestError(`Unknown workspace: ${workspaceId}`))
        const cwd = workspace.path

        const inside = yield* Effect.promise(() => runGit(cwd, ["rev-parse", "--is-inside-work-tree"]))
        if (inside.stdout.trim() !== "true") return null

        const [commonDirRaw, remotesRaw, worktreesRaw, originHead] = yield* Effect.promise(async () =>
          Promise.all([
            runGit(cwd, ["rev-parse", "--git-common-dir"]),
            runGit(cwd, ["remote", "-v"]),
            runGit(cwd, ["worktree", "list", "--porcelain"]),
            runGit(cwd, ["symbolic-ref", "--short", "refs/remotes/origin/HEAD"]),
          ]),
        )

        // --git-common-dir is relative to cwd; resolve to an absolute, canonical
        // key so two workspaces in the same clone map to one repository row.
        const commonGitDir = path.resolve(cwd, commonDirRaw.stdout.trim())
        const remotes = parseRemotes(remotesRaw.stdout)
        const github = githubIdentity(remotes)
        const worktrees = parseWorktreeList(worktreesRaw.stdout)
        // origin/HEAD → the short default branch (strip the leading "origin/").
        const defaultBranch = originHead.exitCode === 0
          ? trimmedOrUndefined(originHead.stdout.replace(/^origin\//, "")) ?? null
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
        return rows
      }).pipe(Effect.withSpan("arc.git.sync_pull_requests", { attributes: { "arc.workspace_id": workspaceId } }))

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

    return GitService.of({
      status,
      detectRepository,
      syncPullRequests,
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
