import { PatchDiff } from "@pierre/diffs/react"
import { type JSX, useEffect, useMemo, useState } from "react"
import type { GitChangeStatus, GitFileChange, GitStatus } from "../../../shared/git.js"
import type { Workspace } from "../../../shared/workspace.js"
import { Button } from "../ui/Button.js"
import { ROW_BASE } from "../sidebar/row-styles.js"
import { rpc } from "../rpc-client.js"

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

  useEffect(() => {
    setStatus(undefined)
    reload()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [workspace?.id])

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
        <Button size="sm" variant="ghost" disabled={loading} onClick={reload}>
          Refresh
        </Button>
      </div>
      {error && <div className={ERROR_BANNER}>{error}</div>}
      {!loading && status?.isRepo === false ? (
        <EmptyState label="This workspace is not a git repository" />
      ) : !loading && grouped.length === 0 ? (
        // No changes: a single full-pane empty state, not the master-detail
        // split — otherwise the message renders inside the capped list box with
        // nothing to center against, and the stale diff header lingers below.
        <EmptyState label="No changes" />
      ) : (
        // Master-detail in one pane: the changed-file list on top (capped so it
        // never crowds out the diff), the selected file's diff filling the rest.
        <div className="flex min-h-0 flex-1 flex-col">
          <div className="max-h-[45%] flex-none overflow-y-auto border-b border-border">
            <ChangedFilesList
              loading={loading}
              grouped={grouped}
              selectedPath={effectiveSelectedPath}
              onSelect={onSelectPath}
            />
          </div>
          <GitFileDiff workspace={workspace} selectedPath={effectiveSelectedPath} />
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
    <Button
      className={[ROW_BASE, "gap-2 px-3", selected ? "bg-accent/15" : ""].filter(Boolean).join(" ")}
      onClick={onSelect}
    >
      <span className={`w-3 flex-none font-mono text-[11px] font-semibold ${STATUS_COLOR[file.status]}`}>
        {STATUS_GLYPH[file.status]}
      </span>
      <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
        {file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}
      </span>
      {file.staged && <span className="flex-none text-[10px] text-fg-dim">staged</span>}
      {stat && <span className="flex-none font-mono text-[10px] text-fg-dim">{stat}</span>}
    </Button>
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
