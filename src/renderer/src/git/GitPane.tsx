import { PatchDiff } from "@pierre/diffs/react"
import { CaretDown, CaretRight } from "@phosphor-icons/react"
import { Fragment, type JSX, type ReactNode, useState } from "react"
import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { GitChangeStatus, GitCommit, GitFileChange } from "../../../shared/git.js"
import type { Workspace } from "../../../shared/workspace.js"
import { DISCLOSURE, Row, ROW_GRID } from "../ui/Row.js"
import { DisclosureSection } from "../ui/DisclosureSection.js"
import { gitFileDiffAtomFor, successOr } from "../atoms.js"
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
  // Which files have their diff expanded inline. Multiple may be open at once;
  // seeded from the incoming selection so a remount keeps that file open.
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() =>
    selectedPath ? new Set([selectedPath]) : new Set(),
  )

  const toggleFile = (path: string): void => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else {
        next.add(path)
        onSelectPath(path)
      }
      return next
    })
  }

  // The service already returns changes sorted by status then path, so the
  // renderer lists them flat — the row's coloured glyph carries the status, no
  // group headers needed.
  const changes = status?.changes ?? []

  return (
    <section className="flex h-full min-h-0 min-w-0 flex-col bg-background">
      {/* Pinned context strip — stays put while the sections scroll. */}
      <RepoContextBar context={context} />
      {error && <div className={ERROR_BANNER}>{error}</div>}
      {!loading && status?.isRepo === false ? (
        <EmptyState label="This workspace is not a git repository" />
      ) : (
        // Sections are flex siblings: an open one grows and scrolls internally; a
        // collapsed one shrinks to just its header so the other takes the space.
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
                workspace={workspace}
                expanded={expanded}
                onToggle={toggleFile}
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
    <DisclosureSection title={title} count={count} open={open} onToggle={onToggle} fill>
      {children}
    </DisclosureSection>
  )
}

/** One file's diff, fetched lazily and rendered inline beneath its row in the
 * changes list. No header — the file row above it is the header. */
function InlineDiff({ workspace, path }: { readonly workspace: Workspace; readonly path: string }): JSX.Element {
  const result = useAtomValue(gitFileDiffAtomFor(workspace.id, path))
  const error = Option.match(AsyncResult.error(result), { onNone: () => undefined, onSome: (e) => e.message })
  const diff = successOr(result, undefined)?.diff

  return (
    <div className="border-b border-border bg-elev/40 px-2 py-2">
      {error ? (
        <span className="text-[12px] text-danger">{error}</span>
      ) : diff === undefined ? (
        <span className="text-[12px] text-fg-dim">Loading diff…</span>
      ) : diff === "" ? (
        <span className="text-[12px] text-fg-dim">No diff available</span>
      ) : (
        <DiffBody diff={diff} />
      )}
    </div>
  )
}

/** The diff content itself — a syntax-highlighted patch when it parses as one,
 * else a plain monospace fallback. Renders at natural height; the changes list
 * scrolls. */
function DiffBody({ diff }: { readonly diff: string }): JSX.Element {
  if (isPatch(diff)) {
    return (
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
    )
  }
  const lines = diff.split("\n").slice(0, 4000)
  return (
    <pre className="m-0 whitespace-pre-wrap font-mono text-[11.5px] leading-[1.45] text-fg-dim">
      {lines.join("\n")}
    </pre>
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
  return <div className="pl-row-indent pr-2 py-2 text-[12px] text-fg-dim">{label}</div>
}

/** The changed files, flat and already status-sorted. Each row toggles its own
 * diff inline beneath it; the leading glyph (its colour) is the status cue, so
 * rows carry no textual status label. */
function ChangedFilesList({
  changes,
  workspace,
  expanded,
  onToggle,
}: {
  readonly changes: ReadonlyArray<GitFileChange>
  readonly workspace: Workspace
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (path: string) => void
}): JSX.Element {
  return (
    <div className="py-1">
      {changes.map((file) => (
        <Fragment key={`${file.originalPath ?? ""}:${file.path}`}>
          <FileRow file={file} expanded={expanded.has(file.path)} onToggle={() => onToggle(file.path)} />
          {expanded.has(file.path) && <InlineDiff workspace={workspace} path={file.path} />}
        </Fragment>
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
  // A flat, caret-less row: text sits flush at the same `pl-2` as the file
  // carets above, no reserved gutter column.
  return (
    <div
      className="flex min-w-0 items-baseline gap-2 py-1 pl-2 pr-2"
      title={`${commit.shortSha} · ${commit.author}`}
    >
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
  expanded,
  onToggle,
}: {
  readonly file: GitFileChange
  readonly expanded: boolean
  readonly onToggle: () => void
}): JSX.Element {
  const stat = file.isBinary
    ? "binary"
    : [file.added > 0 ? `+${file.added}` : undefined, file.deleted > 0 ? `-${file.deleted}` : undefined]
        .filter(Boolean)
        .join(" ")
  return (
    <div className={ROW_GRID} role="treeitem" aria-expanded={expanded}>
      <button
        type="button"
        className={DISCLOSURE}
        onClick={onToggle}
        aria-label={expanded ? `Collapse diff for ${file.path}` : `Expand diff for ${file.path}`}
      >
        {expanded ? <CaretDown size={11} weight="bold" /> : <CaretRight size={11} weight="bold" />}
      </button>
      <Row active={expanded} className="min-w-0 justify-start gap-1.5" onClick={onToggle}>
        <span className={`w-3 flex-none text-center font-mono text-[11px] font-semibold ${STATUS_COLOR[file.status]}`}>
          {STATUS_GLYPH[file.status]}
        </span>
        <span className="min-w-0 flex-1 truncate font-mono text-[12px] text-foreground">
          {file.originalPath ? `${file.originalPath} -> ${file.path}` : file.path}
        </span>
        {file.staged && <span className="flex-none text-[10px] text-fg-dim">staged</span>}
        {stat && <span className="flex-none font-mono text-[10px] text-fg-dim">{stat}</span>}
      </Row>
    </div>
  )
}

function isPatch(diff: string): boolean {
  return diff.startsWith("diff ") || diff.includes("\n@@ ")
}
