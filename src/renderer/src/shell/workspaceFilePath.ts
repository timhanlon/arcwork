import type { WorkspaceId } from "../../../shared/ids.js"
import type { Workspace } from "../../../shared/workspace.js"

/** An absolute filesystem path plus an optional 1-based line to jump to. */
export interface FileHrefTarget {
  readonly path: string
  readonly line?: number
}

// A trailing line locator on a linked path: the `path:line` (optionally
// `:line:col`) convention every dev tool prints, or GitHub's `#Lline` (optionally
// `#LlineCcol`). Captured so the editor can jump to the line; stripped so it
// never reaches the filesystem as part of the name (a `README.md:7` realpath is
// ENOENT). A colon inside a filename with no trailing digits doesn't match.
const LINE_LOCATOR = /^(.+?)(?:#L(\d+)(?:C\d+)?|:(\d+)(?::\d+)?)$/

/**
 * An assistant-linked file href → an absolute filesystem path (and its line, when
 * the link carried one), or `undefined` when it isn't one we route in-app.
 * Accepts a bare absolute POSIX path (`/Users/…/foo.ts`) or a `file://` URL.
 * Anything relative or non-file (http/mailto/arc) returns `undefined`.
 */
export const fileHrefToPath = (href: string): FileHrefTarget | undefined => {
  let p = href
  if (/^file:\/\//i.test(p)) {
    try {
      p = decodeURIComponent(new URL(p).pathname)
    } catch {
      return undefined
    }
  }
  if (!p.startsWith("/")) return undefined
  const m = LINE_LOCATOR.exec(p)
  if (!m) return { path: p }
  return { path: m[1]!, line: Number(m[2] ?? m[3]) }
}

/**
 * Locate the open workspace that contains `absPath` and split it into that
 * workspace's id + the path relative to its root. The longest matching root
 * wins so a nested worktree (…/repo/wt) is preferred over its parent (…/repo).
 * The workspace root itself is a directory, never a file, so an exact-root match
 * is rejected (the `/`-terminated prefix can't match the bare root). `undefined`
 * when the path is outside every open workspace.
 */
export const resolveWorkspaceFile = (
  workspaces: ReadonlyArray<Workspace>,
  absPath: string,
): { readonly workspaceId: WorkspaceId; readonly path: string } | undefined => {
  let best: Workspace | undefined
  for (const ws of workspaces) {
    const prefix = ws.path.endsWith("/") ? ws.path : `${ws.path}/`
    if (absPath.startsWith(prefix) && (!best || ws.path.length > best.path.length)) best = ws
  }
  if (!best) return undefined
  const prefix = best.path.endsWith("/") ? best.path : `${best.path}/`
  return { workspaceId: best.id, path: absPath.slice(prefix.length) }
}
