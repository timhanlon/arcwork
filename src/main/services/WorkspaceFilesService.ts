import { Context, Effect, Layer } from "effect"
import { execFile } from "node:child_process"
import type { Dirent } from "node:fs"
import * as fs from "node:fs/promises"
import * as path from "node:path"
import type { WorkspaceFiles } from "../../shared/rpc.js"
import type { ArcRequestError } from "../errors.js"
import { WorkspaceService } from "./WorkspaceService.js"

/**
 * Lists the files under a workspace root so the chat composer's `@` picker can
 * offer file references. The source of truth is `git ls-files` (tracked +
 * untracked-but-not-ignored), which is fast and respects `.gitignore` — exactly
 * the set a developer thinks of as "the project's files", with no `node_modules`
 * or build-output noise. When the root isn't a git repo (or git is unavailable)
 * we fall back to a bounded directory walk that skips the usual heavy dirs.
 *
 * The caller names a workspace by *id*, not by path: arc resolves the root from
 * its own persisted workspace list, so the renderer can never point file
 * enumeration at an arbitrary filesystem location across the RPC seam. An
 * unknown id is a request error.
 *
 * Results are relative POSIX paths, capped at {@link FILE_CAP}; `truncated` says
 * whether the cap was hit so the picker can tell the user the list is partial
 * rather than silently implying it's complete.
 */
export class WorkspaceFilesService extends Context.Service<
  WorkspaceFilesService,
  {
    readonly list: (workspaceId: string) => Effect.Effect<WorkspaceFiles, ArcRequestError>
  }
>()("WorkspaceFilesService") {}

/** Hard ceiling on returned paths — enough for fuzzy-matching, bounded for IPC. */
const FILE_CAP = 8000

/** Directories the fs-walk fallback never descends into (git already excludes these). */
const SKIP_DIRS = new Set([
  ".git",
  "node_modules",
  "dist",
  "build",
  "out",
  ".next",
  ".turbo",
  ".cache",
  "coverage",
  ".venv",
  "target",
])

const runGitLsFiles = (root: string): Promise<ReadonlyArray<string>> =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["-C", root, "ls-files", "--cached", "--others", "--exclude-standard", "-z"],
      { maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error) {
          reject(error)
          return
        }
        // NUL-delimited so paths with spaces/newlines survive; trailing NUL → drop empties.
        resolve(stdout.split("\0").filter((p) => p.length > 0))
      },
    )
  })

const walkDir = async (root: string, cap: number): Promise<ReadonlyArray<string>> => {
  const out: Array<string> = []
  const stack: Array<string> = [root]
  while (stack.length > 0 && out.length < cap) {
    const dir = stack.pop()!
    let entries: Array<Dirent>
    try {
      entries = await fs.readdir(dir, { withFileTypes: true })
    } catch {
      continue
    }
    for (const entry of entries) {
      if (out.length >= cap) break
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue
        stack.push(path.join(dir, entry.name))
      } else if (entry.isFile()) {
        out.push(path.relative(root, path.join(dir, entry.name)))
      }
    }
  }
  return out
}

export const WorkspaceFilesServiceLive = Layer.effect(
  WorkspaceFilesService,
  Effect.gen(function* () {
    const workspaces = yield* WorkspaceService
    return WorkspaceFilesService.of({
      list: (workspaceId) =>
        Effect.gen(function* () {
          // Resolve the root from arc's own list — never trust a path off the
          // wire. The stored path is already absolute/resolved (WorkspaceService).
          const workspace = yield* workspaces.get(workspaceId)
          const root = workspace.path
          // `Effect.promise` (E = never): the async closure handles its own failures
          // — git first, then an fs walk, then an empty list — so the picker simply
          // has no file candidates if both fail rather than erroring the seam.
          const all = yield* Effect.promise(async (): Promise<ReadonlyArray<string>> => {
            try {
              return await runGitLsFiles(root)
            } catch {
              // Not a git repo (or no git): walk the tree, skipping heavy dirs.
              try {
                return await walkDir(root, FILE_CAP + 1)
              } catch {
                return []
              }
            }
          })
          // Normalize to POSIX separators so tokens read the same on every platform.
          const normalized = all.map((p) => p.split(path.sep).join("/"))
          const truncated = normalized.length > FILE_CAP
          return { files: truncated ? normalized.slice(0, FILE_CAP) : normalized, truncated }
        }).pipe(
          Effect.withSpan("arc.workspace.list_files", {
            attributes: { "arc.workspace_id": workspaceId },
          }),
        ),
    })
  }),
)
