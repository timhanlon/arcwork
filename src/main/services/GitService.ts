import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { GitChangeStatus, GitFileChange, GitFileDiff, GitStatus } from "../../shared/git.js"
import type { Workspace } from "../../shared/workspace.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { WorkspaceService } from "./WorkspaceService.js"

export class GitService extends Context.Service<
  GitService,
  {
    readonly status: (workspaceId: string) => Effect.Effect<GitStatus, ArcRequestError>
    readonly diff: (workspaceId: string, filePath: string) => Effect.Effect<GitFileDiff, ArcRequestError>
  }
>()("GitService") {}

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

export const GitServiceLive = Layer.effect(
  GitService,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceService

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
