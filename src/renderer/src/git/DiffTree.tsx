import {
  CaretDown,
  CaretRight,
  Database,
  FileText,
  Folder,
  GearSix,
  TestTube,
} from "@phosphor-icons/react"
import type { Icon } from "@phosphor-icons/react"
import { Fragment, type JSX, type ReactNode, useState } from "react"
import type {
  DiffFileKind,
  DiffTree as DiffTreeModel,
  DiffTreeFile,
  DiffTreeGroup,
  GitChangeStatus,
} from "../../../shared/git.js"

/**
 * The diff tree — the "how much energy does this need?" read on a change-set,
 * shown before any diff text.
 *
 * A raw `+414 −60` can't distinguish a lockfile bump from a rewrite of the
 * billing core, so this surface leads with the split the number hides: how many
 * files a person actually authored, how many a tool emitted, and how many modules
 * are in play. Generated files are
 * collapsed into one row at the bottom where they can't inflate the total.
 *
 * The ordering is supplied by the service (module groups ranked by structural
 * movement, tests following the module they cover) — this component renders that
 * order, it never re-sorts.
 */

export interface DiffTreeProps {
  readonly tree: DiffTreeModel
  /** Toggle a file's diff. Omit to render the tree as a read-only overview. */
  readonly onSelectFile?: (path: string) => void
  readonly selectedPath?: string
  /** Paths whose diff is currently open. */
  readonly expandedPaths?: ReadonlySet<string>
  /** Body rendered beneath an expanded file row — the inline diff. Kept as a
   * render prop so this component stays presentational and never fetches. */
  readonly renderFileBody?: (file: DiffTreeFile) => ReactNode
  /** Drop the "Diff tree" title row, keeping the stat tiles. Set when an
   * enclosing section header already names the surface. */
  readonly hideTitle?: boolean
}

const KIND_ICON: Record<DiffFileKind, Icon> = {
  source: Folder,
  test: TestTube,
  schema: Database,
  config: GearSix,
  docs: FileText,
  generated: Folder,
}

/** The status vocabulary the Git pane has always used — one letter, coloured.
 * The tree groups by module rather than by status, so this stays the only cue
 * for whether a file was added, deleted or merely modified. */
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

const KIND_ICON_COLOR: Record<DiffFileKind, string> = {
  source: "text-fg-dim",
  test: "text-ok",
  schema: "text-request",
  config: "text-fg-dim",
  docs: "text-fg-dim",
  generated: "text-fg-faint",
}

export function DiffTree({
  tree,
  onSelectFile,
  selectedPath,
  expandedPaths,
  renderFileBody,
  hideTitle = false,
}: DiffTreeProps): JSX.Element {
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set(tree.groups.filter((group) => group.defaultCollapsed).map((group) => group.id)),
  )

  const toggle = (id: string): void =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  if (tree.groups.length === 0) {
    return (
      <div className="px-3 py-6 text-center text-[12px] text-fg-dim">
        No changes
      </div>
    )
  }

  return (
    // A container context, not a viewport one: this lives in a resizable pane, so
    // the stat tiles have to reflow against the pane's width, not the window's.
    <div className="@container flex min-h-0 flex-col">
      <TreeHeader tree={tree} hideTitle={hideTitle} />
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tree.groups.map((group) => (
          <GroupBlock
            key={group.id}
            group={group}
            collapsed={collapsed.has(group.id)}
            onToggle={() => toggle(group.id)}
            onSelectFile={onSelectFile}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            renderFileBody={renderFileBody}
          />
        ))}
      </div>
    </div>
  )
}

/** Title row plus the stat tiles — the whole "should I sit down for this?" read. */
function TreeHeader({
  tree,
  hideTitle,
}: {
  readonly tree: DiffTreeModel
  readonly hideTitle: boolean
}): JSX.Element {
  return (
    <div className="flex-none border-b border-border px-3 pb-3 pt-2.5">
      {hideTitle ? (
        <div className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-mono text-[10px] text-fg-faint">
            Working tree
          </span>
          <Churn added={tree.added} deleted={tree.deleted} className="text-[12px]" />
        </div>
      ) : (
        <>
          <div className="flex items-baseline gap-2">
            <span className="min-w-0 flex-1 truncate text-[13px] font-medium text-foreground">Diff tree</span>
            <Churn added={tree.added} deleted={tree.deleted} className="text-[12px]" />
          </div>
        </>
      )}

      {/* Only shown when sem actually ran — without it there is no entity signal
          to report, and a silent zero would read as "nothing changed". */}
      {tree.semAvailable && (
        <div className="mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5 text-[11px] text-fg-dim">
          <span>{tree.stats.entitiesChanged} entities changed</span>
          {tree.stats.cosmeticOnlyFiles > 0 && (
            <span>{tree.stats.cosmeticOnlyFiles} files formatting-only</span>
          )}
        </div>
      )}
    </div>
  )
}

function GroupBlock({
  group,
  collapsed,
  onToggle,
  onSelectFile,
  selectedPath,
  expandedPaths,
  renderFileBody,
}: {
  readonly group: DiffTreeGroup
  readonly collapsed: boolean
  readonly onToggle: () => void
  readonly onSelectFile?: (path: string) => void
  readonly selectedPath?: string
  readonly expandedPaths?: ReadonlySet<string>
  readonly renderFileBody?: (file: DiffTreeFile) => ReactNode
}): JSX.Element {
  const GroupIcon = KIND_ICON[group.kind]
  // A standalone file group is its own row — the header already names the file,
  // so repeating it as a single child underneath would be noise.
  const standalone = group.files.length === 1 && group.label === group.files[0]?.path
  const standaloneFile = standalone ? group.files[0] : undefined

  return (
    <div className="border-b border-border last:border-b-0">
      <button
        type="button"
        onClick={standalone && onSelectFile ? () => onSelectFile(group.label) : onToggle}
        aria-expanded={standalone ? undefined : !collapsed}
        className="flex w-full min-w-0 cursor-pointer items-start gap-1.5 border-0 bg-transparent px-2 py-2 text-left hover:bg-elev focus-visible:bg-elev focus-visible:outline-none"
      >
        <span className="flex-none pt-[3px] text-fg-faint">
          {standalone ? (
            <span className="inline-block w-[11px]" />
          ) : collapsed ? (
            <CaretRight size={11} weight="bold" />
          ) : (
            <CaretDown size={11} weight="bold" />
          )}
        </span>
        <GroupIcon size={14} weight="duotone" className={`mt-px flex-none ${KIND_ICON_COLOR[group.kind]}`} />
        <span className="min-w-0 flex-1">
          <span className="flex min-w-0 items-baseline gap-2">
            <span
              className={`min-w-0 flex-1 truncate font-mono text-[12.5px] ${
                group.kind === "generated" ? "text-fg-dim" : "text-foreground"
              }`}
            >
              {group.label}
            </span>
            <Churn added={group.added} deleted={group.deleted} muted={group.kind === "generated"} />
          </span>
          {group.caption && <span className="mt-0.5 block text-[11px] text-fg-dim">{group.caption}</span>}
        </span>
      </button>

      {!collapsed && !standalone && (
        <div className="pb-1.5">
          {group.files.map((file) => (
            <Fragment key={file.path}>
              <FileRow
                file={file}
                selected={file.path === selectedPath}
                onSelect={onSelectFile ? () => onSelectFile(file.path) : undefined}
              />
              {expandedPaths?.has(file.path) && renderFileBody?.(file)}
            </Fragment>
          ))}
        </div>
      )}
      {standaloneFile && expandedPaths?.has(group.label) && renderFileBody?.(standaloneFile)}
    </div>
  )
}

function FileRow({
  file,
  selected,
  onSelect,
}: {
  readonly file: DiffTreeFile
  readonly selected: boolean
  readonly onSelect?: () => void
}): JSX.Element {
  const entities = file.entities
  const cosmeticOnly =
    entities !== null &&
    entities.cosmetic > 0 &&
    entities.structural === 0 &&
    entities.added === 0 &&
    entities.removed === 0

  const content = (
    <>
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span
          className={`w-3 flex-none text-center font-mono text-[11px] font-semibold ${STATUS_COLOR[file.status]}`}
          title={file.status}
        >
          {STATUS_GLYPH[file.status]}
        </span>
        <span
          className={`min-w-0 flex-1 truncate font-mono text-[12px] ${
            cosmeticOnly ? "text-fg-dim" : "text-foreground"
          }`}
        >
          {file.originalPath ? `${file.originalPath} → ${file.displayPath}` : file.displayPath}
        </span>
        {file.isBinary ? (
          <span className="flex-none font-mono text-[10.5px] text-fg-dim">binary</span>
        ) : (
          <Churn added={file.added} deleted={file.deleted} muted={file.kind === "generated"} />
        )}
      </span>
      {file.topEntities.length > 0 && (
        <span className="mt-0.5 block truncate font-mono text-[10.5px] text-fg-faint">
          {file.topEntities.join(", ")}
        </span>
      )}
    </>
  )

  const className = `block w-full min-w-0 border-0 bg-transparent py-1 pl-[42px] pr-2 text-left ${
    selected ? "bg-elev" : ""
  }`

  return onSelect ? (
    <button type="button" onClick={onSelect} className={`${className} cursor-pointer hover:bg-elev focus-visible:bg-elev focus-visible:outline-none`}>
      {content}
    </button>
  ) : (
    <div className={className}>{content}</div>
  )
}

/** `+n −n`, with each half hidden when zero so an add-only row reads clean. */
function Churn({
  added,
  deleted,
  muted = false,
  className = "text-[11.5px]",
}: {
  readonly added: number
  readonly deleted: number
  readonly muted?: boolean
  readonly className?: string
}): JSX.Element {
  return (
    <span className={`flex flex-none items-baseline gap-1 whitespace-nowrap font-mono tabular-nums ${className}`}>
      {added > 0 && <span className={muted ? "text-fg-dim" : "text-ok"}>+{added.toLocaleString()}</span>}
      {deleted > 0 && <span className={muted ? "text-fg-dim" : "text-danger"}>−{deleted.toLocaleString()}</span>}
      {added === 0 && deleted === 0 && <span className="text-fg-faint">0</span>}
    </span>
  )
}
