import { PatchDiff } from "@pierre/diffs/react"
import { CaretDown, CaretRight } from "@phosphor-icons/react"
import { type JSX, type ReactNode, useEffect, useMemo, useState } from "react"
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
  "mx-3 mt-2.5 flex-none rounded-[var(--radius)] border border-danger px-2 py-1.5 text-[12px] text-danger"

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface GitFileDiffProps {
  readonly workspace?: Workspace
  readonly selectedPath?: string
}

export function GitPane({ workspace, selectedPath, onSelectPath }: GitPaneProps): JSX.Element {
  if (!workspace) {
    return (
      <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
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
  const [changesOpen, setChangesOpen] = useState(true)
  const [commitsOpen, setCommitsOpen] = useState(true)

  // The service already returns changes sorted by status then path, so the
  // renderer lists them flat — the row's coloured glyph carries the status, no
  // group headers needed.
  const changes = status?.changes ?? []

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
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {/* Pinned context strip — stays put while the sections and diff scroll. */}
      <RepoContextBar context={context} />
      {error && <div className={ERROR_BANNER}>{error}</div>}
      {!loading && status?.isRepo === false ? (
        <EmptyState label="This workspace is not a git repository" />
      ) : (
        <div className="flex min-h-0 flex-1 flex-col">
          {/* Collapsible sections share the space above the diff; an open one
              grows and scrolls internally, a collapsed one shrinks to its header. */}
          <div className="flex min-h-0 flex-1 flex-col">
            <GitSection
              title="Changes"
              count={status ? changes.length : undefined}
              open={changesOpen}
              onToggle={() => setChangesOpen((v) => !v)}
            >
              {loading ? (
                <ListNote label="Loading changes" />
              ) : changes.length === 0 ? (
                <ListNote label="No changes" />
              ) : (
                <ChangedFilesList
                  changes={changes}
                  selectedPath={effectiveSelectedPath}
                  onSelect={onSelectPath}
                />
              )}
            </GitSection>
            <GitSection
              title="Commits"
              count={commitsLoading ? undefined : commits.length}
              open={commitsOpen}
              onToggle={() => setCommitsOpen((v) => !v)}
            >
              {commitsLoading ? (
                <ListNote label="Loading commits" />
              ) : commits.length === 0 ? (
                <ListNote label="No commits on this branch" />
              ) : (
                <CommitsList commits={commits} />
              )}
            </GitSection>
          </div>
          {effectiveSelectedPath && (
            <div className="flex min-h-0 flex-[1.6] flex-col border-t border-border">
              <GitFileDiff workspace={workspace} selectedPath={effectiveSelectedPath} />
            </div>
          )}
        </div>
      )}
    </section>
  )
}

/** A collapsible pane section (Changes / Commits). The header toggles it; when
 * open it grows to fill its share of the pane and scrolls internally, when closed
 * it collapses to just the header. */
function GitSection({
  title,
  count,
  open,
  onToggle,
  children,
}: {
  readonly title: string
  readonly count?: number
  readonly open: boolean
  readonly onToggle: () => void
  readonly children: ReactNode
}): JSX.Element {
  return (
    <div className={`flex min-h-0 flex-col border-b border-border ${open ? "flex-1" : "flex-none"}`}>
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full flex-none items-center gap-1.5 px-3 py-1.5 text-left font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint hover:bg-elev focus-visible:bg-elev focus-visible:outline-none"
      >
        {open ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
        <span>{title}</span>
        {count !== undefined && <span className="text-fg-dim">{count}</span>}
      </button>
      {open && <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>}
    </div>
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
    <div className="flex min-h-0 flex-1 items-center justify-center px-3 text-center text-[12px] text-fg-dim">
      {label}
    </div>
  )
}

/** A top-aligned note inside a list box. Shares the list rows' horizontal padding
 * so a placeholder → list transition doesn't shift the content (the load jank). */
function ListNote({ label }: { readonly label: string }): JSX.Element {
  return <div className="px-3 py-2 text-[12px] text-fg-dim">{label}</div>
}

/** The changed files, flat and already status-sorted. The leading glyph (its
 * colour) is the status cue, so rows carry no textual status label. */
function ChangedFilesList({
  changes,
  selectedPath,
  onSelect,
}: {
  readonly changes: ReadonlyArray<GitFileChange>
  readonly selectedPath?: string
  readonly onSelect: (path: string) => void
}): JSX.Element {
  return (
    <div className="py-1">
      {changes.map((file) => (
        <FileRow
          key={`${file.originalPath ?? ""}:${file.path}`}
          file={file}
          selected={selectedPath === file.path}
          onSelect={() => onSelect(file.path)}
        />
      ))}
    </div>
  )
}

/** The branch's commits, newest first — a flat list of one-line rows (the
 * enclosing section supplies the header). */
function CommitsList({ commits }: { readonly commits: ReadonlyArray<GitCommit> }): JSX.Element {
  return (
    <div className="py-1">
      {commits.map((commit) => (
        <CommitRow key={commit.sha} commit={commit} />
      ))}
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
    <div className="flex min-h-0 flex-1 flex-col">
      {path && (
        <div className="flex h-9 flex-none items-center border-b border-border px-3">
          <span className="min-w-0 truncate font-mono text-[11px] text-fg-dim">{path}</span>
        </div>
      )}
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
