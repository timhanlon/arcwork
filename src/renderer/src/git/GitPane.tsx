import { PatchDiff } from "@pierre/diffs/react"
import { type JSX, useEffect, useMemo, useState } from "react"
import type { GitChangeStatus, GitCommit, GitFileChange } from "../../../shared/git.js"
import type { Workspace } from "../../../shared/workspace.js"
import { Row } from "../ui/Row.js"
import { rpc } from "../rpc-client.js"
import { RepoContextBar } from "./RepoContextBar.js"
import { useWorkspaceGit } from "./useWorkspaceGit.js"

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

const ERROR_BANNER =
  "mx-4 mt-2.5 flex-none rounded-[var(--radius)] border border-danger px-2 py-1.5 text-[12px] text-danger"

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface GitFileDiffProps {
  readonly workspace?: Workspace
  readonly selectedPath?: string
}

export function GitPane({ workspace, selectedPath, onSelectPath }: GitPaneProps): JSX.Element {
  if (!workspace) {
    return (
      <section className="flex min-h-0 min-w-0 flex-col bg-background">
        <EmptyState label="Open a workspace to view git changes" />
      </section>
    )
  }
  // Keyed on the workspace so switching workspaces remounts the body — its
  // auto-select effect re-runs against the new workspace's change set.
  return (
    <GitPaneBody
      key={workspace.id}
      workspace={workspace}
      selectedPath={selectedPath}
      onSelectPath={onSelectPath}
    />
  )
}

/** The Git pane for a known workspace. Reads the shared git atoms (warmed by the
 * prefetch, so usually no load flash) rather than fetching into local state. */
function GitPaneBody({
  workspace,
  selectedPath,
  onSelectPath,
}: {
  readonly workspace: Workspace
  readonly selectedPath?: string
  readonly onSelectPath: (path: string) => void
}): JSX.Element {
  const { status, context, commits, loading, commitsLoading, error } = useWorkspaceGit(workspace.id)

  const grouped = useMemo(() => {
    const map = new Map<GitChangeStatus, ReadonlyArray<GitFileChange>>()
    for (const change of status?.changes ?? []) {
      map.set(change.status, [...(map.get(change.status) ?? []), change])
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

  // Auto-select the first changed file once status lands, unless the current
  // selection is still in the change set.
  useEffect(() => {
    if (!status) return
    const stillSelected = selectedPath && status.changes.some((change) => change.path === selectedPath)
    const nextPath = stillSelected ? selectedPath : status.changes[0]?.path
    if (nextPath && nextPath !== selectedPath) onSelectPath(nextPath)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status])

  return (
    <section className="flex min-h-0 min-w-0 flex-col bg-background">
      <RepoContextBar context={context} />
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
              <ListNote label="No changes" />
            ) : (
              <ChangedFilesList
                loading={loading}
                grouped={grouped}
                selectedPath={effectiveSelectedPath}
                onSelect={onSelectPath}
              />
            )}
          </div>
          <CommitsList commits={commits} loading={commitsLoading} expanded={!effectiveSelectedPath} />
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

/** A top-aligned note inside a list box. Shares the list rows' horizontal padding
 * so a placeholder → list transition doesn't shift the content (the load jank). */
function ListNote({ label }: { readonly label: string }): JSX.Element {
  return <div className="px-3 py-2 text-[12px] text-fg-dim">{label}</div>
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
  if (loading) return <ListNote label="Loading changes" />

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
  loading,
  expanded,
}: {
  readonly commits: ReadonlyArray<GitCommit>
  readonly loading: boolean
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
        // Same padding for loading and empty so the box doesn't reflow on load.
        <div className="px-3 pb-2 text-[12px] text-fg-dim">
          {loading ? "Loading commits" : "No commits on this branch"}
        </div>
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
