import { useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { type JSX, useMemo, useState } from "react"
import { File, Folder, FolderOpen } from "@phosphor-icons/react"
import type { WorkspaceId } from "../../../shared/ids.js"
import { arcImgFileSrc, isImagePath } from "../../../shared/images.js"
import { workspaceFilesAtom } from "../atoms.js"
import { DisclosureSection } from "../ui/DisclosureSection.js"
import { Caret } from "../ui/Caret.js"
import { useShellActions } from "../shell/ShellActionsContext.js"

interface DirectoryNode {
  readonly dirs: ReadonlyMap<string, DirectoryNode>
  readonly files: ReadonlyArray<string>
}

const emptyDirectory = (): DirectoryNode => ({ dirs: new Map(), files: [] })

const makeTree = (paths: ReadonlyArray<string>): DirectoryNode => {
  const root: { dirs: Map<string, DirectoryNode>; files: Array<string> } = { dirs: new Map(), files: [] }
  for (const path of paths) {
    const parts = path.split("/")
    let current = root
    for (const part of parts.slice(0, -1)) {
      const existing = current.dirs.get(part)
      if (existing) current = existing as { dirs: Map<string, DirectoryNode>; files: Array<string> }
      else {
        const next: { dirs: Map<string, DirectoryNode>; files: Array<string> } = { dirs: new Map(), files: [] }
        current.dirs.set(part, next)
        current = next
      }
    }
    const name = parts.at(-1)
    if (name) current.files.push(name)
  }
  return root
}

export function WorkspaceFilesTree({
  workspaceId,
  workspacePath,
}: {
  readonly workspaceId?: WorkspaceId
  readonly workspacePath?: string
}): JSX.Element | null {
  if (!workspaceId) return null
  return <WorkspaceFilesTreeForWorkspace workspaceId={workspaceId} workspacePath={workspacePath} />
}

function WorkspaceFilesTreeForWorkspace({
  workspaceId,
  workspacePath,
}: {
  readonly workspaceId: WorkspaceId
  readonly workspacePath?: string
}): JSX.Element {
  const result = useAtomValue(workspaceFilesAtom(workspaceId))
  const [open, setOpen] = useState(true)
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set())
  const actions = useShellActions()
  const paths = AsyncResult.isSuccess(result) ? result.value.files : []
  const tree = useMemo(
    () => makeTree(AsyncResult.isSuccess(result) ? result.value.files : []),
    [result],
  )
  const toggle = (key: string): void => {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(key)) next.delete(key)
      else next.add(key)
      return next
    })
  }
  return (
    <DisclosureSection title="Files" count={AsyncResult.isSuccess(result) ? paths.length : undefined} open={open} onToggle={() => setOpen(!open)}>
      {!AsyncResult.isSuccess(result) ? (
        <div className="px-2 py-2 text-[11px] text-fg-dim">Loading files…</div>
      ) : (
        <div className="pb-1" role="group" aria-label="Workspace files">
          <Directory
            node={tree}
            prefix=""
            depth={0}
            expanded={expanded}
            onToggle={toggle}
            onOpenFile={(path) => {
              if (workspacePath && isImagePath(path)) {
                actions.open(
                  { kind: "image", src: arcImgFileSrc(`${workspacePath}/${path}`), title: path.split("/").at(-1) },
                  "right",
                )
              } else {
                actions.open({ kind: "file", workspaceId, path }, "center")
              }
            }}
          />
          {result.value.truncated ? <div className="px-2 py-1 text-[10px] text-fg-faint">File list is partial</div> : null}
        </div>
      )}
    </DisclosureSection>
  )
}

function Directory({
  node,
  prefix,
  depth,
  expanded,
  onToggle,
  onOpenFile,
}: {
  readonly node: DirectoryNode
  readonly prefix: string
  readonly depth: number
  readonly expanded: ReadonlySet<string>
  readonly onToggle: (path: string) => void
  readonly onOpenFile: (path: string) => void
}): JSX.Element {
  const dirs = [...node.dirs.entries()].sort(([a], [b]) => a.localeCompare(b))
  const files = [...node.files].sort((a, b) => a.localeCompare(b))
  return (
    <>
      {dirs.map(([name, child]) => {
        const path = prefix ? `${prefix}/${name}` : name
        const isOpen = expanded.has(path)
        return (
          <div key={path}>
            <button
              type="button"
              onClick={() => onToggle(path)}
              className="flex h-6 w-full min-w-0 items-center gap-1 px-2 text-left text-[12px] text-fg-dim hover:bg-elev hover:text-foreground"
              style={{ paddingLeft: `${8 + depth * 12}px` }}
              aria-expanded={isOpen}
            >
              <Caret open={isOpen} />
              {isOpen ? <FolderOpen size={14} weight="regular" aria-hidden /> : <Folder size={14} weight="regular" aria-hidden />}
              <span className="truncate">{name}</span>
            </button>
            {isOpen ? <Directory node={child} prefix={path} depth={depth + 1} expanded={expanded} onToggle={onToggle} onOpenFile={onOpenFile} /> : null}
          </div>
        )
      })}
      {files.map((name) => {
        const path = prefix ? `${prefix}/${name}` : name
        return (
          <button
            key={path}
            type="button"
            onClick={() => onOpenFile(path)}
            className="flex h-6 w-full min-w-0 items-center gap-1 px-2 text-left text-[12px] text-fg-dim hover:bg-elev hover:text-foreground"
            style={{ paddingLeft: `${8 + depth * 12 + 14}px` }}
            title={path}
          >
            <File size={14} weight="regular" aria-hidden />
            <span className="truncate">{name}</span>
          </button>
        )
      })}
    </>
  )
}
