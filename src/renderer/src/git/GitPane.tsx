import { PatchDiff } from "@pierre/diffs/react"
import { useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { type JSX, useEffect, useMemo, useState } from "react"
import type {
  GitChangeStatus,
  GitCommit,
  GitFileChange,
  GitStatus,
  WorkspaceGitContext,
} from "../../../shared/git.js"
import type { Workspace } from "../../../shared/workspace.js"
import { gitChangesSignalAtom } from "../atoms.js"
import { Button } from "../ui/Button.js"
import { Row } from "../ui/Row.js"
import { rpc } from "../rpc-client.js"
import { RepoContextBar } from "./RepoContextBar.js"

export interface GitPaneProps {
  readonly workspace?: Workspace
  readonly selectedPath?: string
  readonly onSelectPath: (path: string) => void
}

const STATUS_ORDER: ReadonlyArray<GitChangeStatus> = [
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

const STATUS_LABEL: Record<GitChangeStatus, string> = {
  added: "Added",
  modified: "Modified",
  deleted: "Deleted",
  renamed: "Renamed",
  copied: "Copied",
  untracked: "Untracked",
  unmerged: "Unmerged",
  typeChange: "Type change",
  unknown: "Changed",
}

const STATUS_GLYPH: Record<GitChangeStatus, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  copied: "C",
  untracked: "?",
  unmerged: "U",
  typeChange: "T",
  unknown: ".",
}

const STATUS_COLOR: Record<GitChangeStatus, string> = {
  added: "text-ok",
  untracked: "text-ok",
  modified: "text-request",
  typeChange: "text-request",
  deleted: "text-danger",
  renamed: "text-accent",
  copied: "text-accent",
  unmerged: "text-purple-400",
  unknown: "text-fg-dim",
}

const HEADER = "flex flex-none items-center justify-between gap-2 border-b border-border px-4 pb-3 pt-[14px]"
const PANE_TITLE = "m-0 font-sans text-[15px] font-medium"
const ERROR_BANNER =
  "mx-4 mt-2.5 flex-none rounded-[var(--radius)] border border-danger px-2 py-1.5 text-[12px] text-danger"

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface GitFileDiffProps {
  readonly workspace?: Workspace
  readonly selectedPath?: string
}

export function GitPane({ workspace, selectedPath, onSelectPath }: GitPaneProps): JSX.Element {
  const [status, setStatus] = useState<GitStatus | undefined>(undefined)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [gitContext, setGitContext] = useState<WorkspaceGitContext | undefined>(undefined)
  const [syncing, setSyncing] = useState(false)
  const [commits, setCommits] = useState<ReadonlyArray<GitCommit>>([])

  // Hook-driven refresh: a `post-checkout` branch remap or `pre-push` PR sync
  // ticks this counter for the open workspace (empty key when none, never ticks).
  const gitSignalResult = useAtomValue(gitChangesSignalAtom(workspace?.id ?? ""))
  const gitSignal = AsyncResult.isSuccess(gitSignalResult) ? gitSignalResult.value : 0

  const grouped = useMemo(() => {
    const map = new Map<GitChangeStatus, ReadonlyArray<GitFileChange>>()
    for (const status of STATUS_ORDER) map.set(status, [])
    for (const change of status?.changes ?? []) {
      const existing = map.get(change.status) ?? []
      map.set(change.status, [...existing, change])
    }
    return STATUS_ORDER.map((key) => ({ status: key, files: map.get(key) ?? [] })).filter(
      (group) => group.files.length > 0,
    )
  }, [status?.changes])

  // Honor the selection only while the file is still in the change set. After a
  // commit clears a file, its `gitPath` lingers in shell state; without this the
  // diff sub-pane would keep rendering a header for a file that no longer exists.
  const effectiveSelectedPath = useMemo(
    () => (selectedPath && status?.changes.some((change) => change.path === selectedPath) ? selectedPath : undefined),
    [selectedPath, status?.changes],
  )

  const reload = (): void => {
    if (!workspace) return
    setLoading(true)
    setError(undefined)
    rpc("GetWorkspaceGitStatus", { workspaceId: workspace.id })
      .then((next) => {
        setStatus(next)
        const stillSelected = selectedPath && next.changes.some((change) => change.path === selectedPath)
        const nextPath = stillSelected ? selectedPath : next.changes[0]?.path
        if (nextPath && nextPath !== selectedPath) onSelectPath(nextPath)
      })
      .catch((e) => {
        setError(errorMessage(e))
        setStatus(undefined)
      })
      .finally(() => setLoading(false))
  }

  // The repo/PR context is a separate, local read (no network): detect the repo
  // and map the current branch to its PR off the persisted read model.
  const loadContext = (): void => {
    if (!workspace) return
    rpc("GetWorkspaceGitContext", { workspaceId: workspace.id })
      .then(setGitContext)
      .catch(() => setGitContext(undefined))
  }

  // The branch's recent history, a local read alongside the status pull. Empty on
  // any failure (non-repo, unborn branch) — the commits section just stays empty.
  const loadCommits = (): void => {
    if (!workspace) return
    rpc("GetWorkspaceGitCommits", { workspaceId: workspace.id })
      .then(setCommits)
      .catch(() => setCommits([]))
  }

  // The one network refresh: pull PRs from GitHub via gh, then re-read context
  // so the current-branch PR reflects the sync.
  const syncPullRequests = (): void => {
    if (!workspace || syncing) return
    setSyncing(true)
    rpc("SyncWorkspacePullRequests", { workspaceId: workspace.id })
      .then(loadContext)
      .catch((e) => setError(errorMessage(e)))
      .finally(() => setSyncing(false))
  }

  useEffect(() => {
    setStatus(undefined)
    setGitContext(undefined)
    setCommits([])
    reload()
    loadContext()
    loadCommits()
    // Auto-sync PRs on workspace open (a refresh trigger the design calls for):
    // loadContext paints the persisted read model instantly, then this pulls
    // fresh PRs from GitHub in the background so the current-branch PR appears
    // without a manual Sync click. Cheap/no-op for non-GitHub repos.
    syncPullRequests()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id])

  // Re-pull status + context when a git hook signals a change for this
  // workspace. Skips the seed tick (`0`), so it never doubles the mount pull.
  useEffect(() => {
    if (gitSignal === 0) return
    reload()
    loadContext()
    loadCommits()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gitSignal])

  if (!workspace) {
    return (
      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <div className={HEADER}>
          <h2 className={PANE_TITLE}>Git</h2>
        </div>
        <EmptyState label="Open a workspace to view git changes" />
      </section>
    )
  }

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-background">
      <div className={HEADER}>
        <div className="min-w-0">
          <h2 className={PANE_TITLE}>Git</h2>
          <div className="truncate font-mono text-[11px] text-fg-dim">
            {status?.branch ?? status?.head?.slice(0, 7) ?? workspace.name}
          </div>
        </div>
        <Button
          size="sm"
          variant="ghost"
          disabled={loading}
          onClick={() => {
            reload()
            loadCommits()
          }}
        >
          Refresh
        </Button>
      </div>
      <RepoContextBar context={gitContext} syncing={syncing} onSync={syncPullRequests} />
      {error && <div className={ERROR_BANNER}>{error}</div>}
      {!loading && status?.isRepo === false ? (
        <EmptyState label="This workspace is not a git repository" />
      ) : (
        // One pane, stacked: the changed-file list, the branch's commit history,
        // then the selected file's diff. Changes and commits are each capped so
        // the diff (when a file is selected) still has room; with no selection the
        // commit history takes the remaining space.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[35%] flex-none overflow-y-auto border-b border-border">
            {!loading && grouped.length === 0 ? (
              <div className="px-3 py-2 text-[12px] text-fg-dim">No changes</div>
            ) : (
              <ChangedFilesList
                loading={loading}
                grouped={grouped}
                selectedPath={effectiveSelectedPath}
                onSelect={onSelectPath}
              />
            )}
          </div>
          <CommitsList commits={commits} expanded={!effectiveSelectedPath} />
          {effectiveSelectedPath && <GitFileDiff workspace={workspace} selectedPath={effectiveSelectedPath} />}
        </div>
      )}
    </section>
  )
}

/** The selected file's diff, rendered below the changed-file list in the git
 * pane. `DiffView` carries its own header (the file path), so this is just the
 * fetch + the view — no separate pane chrome. */
function GitFileDiff({ workspace, selectedPath }: GitFileDiffProps): JSX.Element {
  const [diff, setDiff] = useState("")
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    if (!workspace || !selectedPath) {
      setDiff("")
      setError(undefined)
      return
    }
    setLoading(true)
    setError(undefined)
    rpc("GetWorkspaceGitFileDiff", { workspaceId: workspace.id, path: selectedPath })
      .then((result) => setDiff(result.diff))
      .catch((e) => {
        setError(errorMessage(e))
        setDiff("")
      })
      .finally(() => setLoading(false))
  }, [workspace, selectedPath])

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {error && <div className={ERROR_BANNER}>{error}</div>}
      <DiffView path={selectedPath} diff={diff} loading={loading} />
    </div>
  )
}

function EmptyState({ label }: { readonly label: string }): JSX.Element {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center px-4 text-center text-[12px] text-fg-dim">
      {label}
    </div>
  )
}

function ChangedFilesList({
  loading,
  grouped,
  selectedPath,
  onSelect,
}: {
  readonly loading: boolean
  readonly grouped: ReadonlyArray<{ readonly status: GitChangeStatus; readonly files: ReadonlyArray<GitFileChange> }>
  readonly selectedPath?: string
  readonly onSelect: (path: string) => void
}): JSX.Element {
  if (loading) return <EmptyState label="Loading changes" />

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {grouped.map((group) => (
        <div key={group.status}>
          <div className="px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint">
            {STATUS_LABEL[group.status]}
          </div>
          {group.files.map((file) => (
            <FileRow
              key={`${file.originalPath ?? ""}:${file.path}`}
              file={file}
              selected={selectedPath === file.path}
              onSelect={() => onSelect(file.path)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

/** The branch's recent commits, newest first: a section header and a scrolling
 * list of one-line rows. `expanded` lets it grow to fill the pane when no file
 * diff is showing, otherwise it's a capped band above the diff. */
function CommitsList({
  commits,
  expanded,
}: {
  readonly commits: ReadonlyArray<GitCommit>
  readonly expanded: boolean
}): JSX.Element {
  return (
    <div
      className={`flex min-h-0 flex-col border-b border-border ${expanded ? "flex-1" : "max-h-[30%] flex-none"}`}
    >
      <div className="flex-none px-3 pb-1 pt-2 font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint">
        Commits
      </div>
      {commits.length === 0 ? (
        <div className="px-3 pb-2 text-[12px] text-fg-dim">No commits on this branch</div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto pb-2">
          {commits.map((commit) => (
            <CommitRow key={commit.sha} commit={commit} />
          ))}
        </div>
      )}
    </div>
  )
}

function CommitRow({ commit }: { readonly commit: GitCommit }): JSX.Element {
  return (
    <div className="flex items-baseline gap-2 px-3 py-[3px]" title={`${commit.shortSha} · ${commit.author}`}>
      <span className="flex-none font-mono text-[11px] text-accent">{commit.shortSha}</span>
      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{commit.subject}</span>
      <span className="flex-none font-mono text-[10px] text-fg-faint">{formatCommitDate(commit.authoredAt)}</span>
    </div>
  )
}

/** ISO author date → a compact `MMM D` / `MMM D, YYYY` label for the row's right
 * edge. Falls back to the raw string if it doesn't parse. */
function formatCommitDate(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const sameYear = date.getFullYear() === new Date().getFullYear()
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  })
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  readonly file: GitFileChange
  readonly selected: boolean
  readonly onSelect: () => void
}): JSX.Element {
  const stat = file.isBinary
    ? "binary"
    : [file.added > 0 ? `+${file.added}` : undefined, file.deleted > 0 ? `-${file.deleted}` : undefined]
        .filter(Boolean)
        .join(" ")
  return (
    <Row active={selected} className="gap-2 px-3" onClick={onSelect}>
      <span className={`w-3 flex-none font-mono text-[11px] font-semibold ${STATUS_COLOR[file.status]}`}>
        {STATUS_GLYPH[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
        {file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}
      </span>
      {file.staged && <span className="flex-none text-[10px] text-fg-dim">staged</span>}
      {stat && <span className="flex-none font-mono text-[10px] text-fg-dim">{stat}</span>}
    </Row>
  )
}

function DiffView({
  path,
  diff,
  loading,
}: {
  readonly path?: string
  readonly diff: string
  readonly loading: boolean
}): JSX.Element {
  const lines = diff.split("\n").slice(0, 4000)
  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex h-9 flex-none items-center gap-2 border-b border-border px-3">
        <span className="text-[13px] font-medium">Diff</span>
        {path && <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim">{path}</span>}
      </div>
      {!path ? (
        <EmptyState label="Select a file to view its diff" />
      ) : loading ? (
        <EmptyState label="Loading diff" />
      ) : isPatch(diff) ? (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <PatchDiff
            patch={diff}
            disableWorkerPool
            className="min-w-0 text-[11px]"
            options={{
              theme: "vitesse-dark",
              themeType: "dark",
              diffStyle: "unified",
              disableLineNumbers: false,
              disableFileHeader: true,
              overflow: "wrap",
              preferredHighlighter: "shiki-js",
            }}
          />
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto px-3 py-2">
          <pre className="m-0 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.45] text-fg-dim">
            {lines.join("\n")}
          </pre>
        </div>
      )}
    </div>
  )
}

function isPatch(diff: string): boolean {
  return diff.startsWith("diff ") || diff.includes("\n@@ ")
}
