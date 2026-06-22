import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { GitChangeStatus, GitFileChange } from "../../../shared/git.js"
import { runGit } from "./exec.js"

export interface GitRemote {
  readonly name: string
  readonly url: string
}

export interface WorktreeEntry {
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

export interface LineStat {
  readonly added: number
  readonly deleted: number
  readonly isBinary: boolean
}

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
  readonly headRepositoryOwner?: { readonly login?: string | null } | null
  readonly headRepository?: { readonly name?: string | null } | null
  readonly baseRefName?: string | null
  readonly reviewDecision?: string | null
  readonly mergeable?: string | null
  readonly mergeStateStatus?: string | null
  readonly url?: string | null
  readonly statusCheckRollup?: ReadonlyArray<Record<string, unknown>> | null
  readonly createdAt?: string | null
  readonly updatedAt?: string | null
}

export const GH_PR_FIELDS = [
  "number",
  "id",
  "title",
  "body",
  "state",
  "isDraft",
  "author",
  "headRefName",
  "headRefOid",
  "headRepositoryOwner",
  "headRepository",
  "baseRefName",
  "reviewDecision",
  "mergeable",
  "mergeStateStatus",
  "url",
  "statusCheckRollup",
  "createdAt",
  "updatedAt",
].join(",")

export const trimmedOrUndefined = (value: string): string | undefined => {
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : undefined
}

export const bool = (value: boolean): number => (value ? 1 : 0)

export const lowerOrNull = (value: string | null | undefined): string | null => {
  const trimmed = value?.trim().toLowerCase()
  return trimmed && trimmed.length > 0 ? trimmed : null
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

export const parseStatusLine = (line: string): GitFileChange | undefined => {
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

export const trackedStats = async (cwd: string): Promise<ReadonlyMap<string, LineStat>> => {
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

export const untrackedStat = async (cwd: string, filePath: string): Promise<LineStat> => {
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

export const statusOrder: ReadonlyArray<GitChangeStatus> = [
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
export const parseRemotes = (stdout: string): ReadonlyArray<GitRemote> => {
  const byName = new Map<string, string>()
  for (const line of stdout.split("\n")) {
    const match = line.match(/^(\S+)\s+(\S+)\s+\((fetch|push)\)$/)
    if (match && match[1] && match[2] && !byName.has(match[1])) byName.set(match[1], match[2])
  }
  return [...byName].map(([name, url]) => ({ name, url }))
}

export const parseRemotesJson = (json: string): ReadonlyArray<GitRemote> => {
  try {
    const raw = JSON.parse(json) as unknown
    if (!Array.isArray(raw)) return []
    return raw.flatMap((entry) => {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as { name?: unknown }).name === "string" &&
        typeof (entry as { url?: unknown }).url === "string"
      ) {
        return [{ name: (entry as { name: string }).name, url: (entry as { url: string }).url }]
      }
      return []
    })
  } catch {
    return []
  }
}

/** Resolve the GitHub owner/repo for a clone: the first remote whose URL is a
 * GitHub URL, preferring `origin`. Carries the resolving remote's name so the
 * default branch can be read off that remote's HEAD rather than assuming
 * `origin`. Null when no remote points at GitHub. */
export const githubIdentity = (
  remotes: ReadonlyArray<GitRemote>,
): { owner: string; repo: string; remote: string } | null => {
  const ordered = [...remotes].sort((a, b) => (a.name === "origin" ? -1 : b.name === "origin" ? 1 : 0))
  for (const remote of ordered) {
    const parsed = parseGithubRemote(remote.url)
    if (parsed) return { ...parsed, remote: remote.name }
  }
  return null
}

/** The remote whose HEAD names the default branch: the GitHub remote if we
 * resolved one, else `origin` when present, else the first remote. Null when the
 * clone has no remotes (a local-only repo has no default branch to read). */
export const defaultBranchRemote = (
  remotes: ReadonlyArray<GitRemote>,
  github: { remote: string } | null,
): string | null =>
  github?.remote ?? remotes.find((r) => r.name === "origin")?.name ?? remotes[0]?.name ?? null

/** Parse `git worktree list --porcelain` into one entry per worktree. Records
 * are blank-line separated; a `branch refs/heads/x` line is shortened to `x`,
 * and the boolean attributes (`detached`/`bare`/`locked`/`prunable`) become
 * flags, carrying any trailing reason text. The first record is the main
 * worktree. */
export const parseWorktreeList = (stdout: string): ReadonlyArray<WorktreeEntry> => {
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

/** The `git log` revision range that isolates a branch's own commits: `base..HEAD`
 * when the workspace is on a non-default branch and the base ref resolves (the
 * local name, else `origin/<base>`); an empty range — i.e. full history — when on
 * the default branch, detached, or the base can't be found. */
export const resolveBranchRange = async (
  cwd: string,
  branch: string | undefined,
  base: string | null,
  remote: string | null = "origin",
): Promise<ReadonlyArray<string>> => {
  if (!branch || !base || branch === base) return []
  const refs = [base, ...(remote ? [`${remote}/${base}`] : [])]
  for (const ref of refs) {
    const check = await runGit(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])
    if (check.exitCode === 0) return [`${ref}..HEAD`]
  }
  return []
}
