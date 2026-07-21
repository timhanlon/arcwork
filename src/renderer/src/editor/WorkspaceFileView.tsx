import { useAtomRefresh, useAtomSet, useAtomValue } from "@effect/atom-react"
import { Cause, Exit, Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { type JSX, useCallback, useEffect, useState } from "react"
import type { WorkspaceId } from "../../../shared/ids.js"
import type { WorkspaceFileContent } from "../../../shared/rpc.js"
import { gitStatusAtom, workspaceFileAtomFor, writeWorkspaceFileAtom } from "../atoms.js"
import { CodeEditor } from "./CodeEditor.js"
import { monacoLanguageId } from "./language.js"

export interface WorkspaceFileViewProps {
  readonly workspaceId: WorkspaceId
  /** Relative POSIX path within the workspace, as returned by `ListWorkspaceFiles`. */
  readonly path: string
  /** 1-based line to reveal, when the opener carried one (`foo.ts:7`). */
  readonly line?: number
  readonly className?: string
  /** Lets the tab owner protect a dirty editor from being closed. */
  readonly onDirtyChange?: (dirty: boolean) => void
}

/**
 * The atom-backed workspace editor. It reads through the typed RPC seam and
 * saves only existing, non-truncated text files through its paired write RPC.
 * Binary and oversized files remain deliberately read-only: editing a partial
 * body would silently destroy the unseen tail on save.
 */
export function WorkspaceFileView({
  workspaceId,
  path,
  line,
  className,
  onDirtyChange,
}: WorkspaceFileViewProps): JSX.Element {
  const result = useAtomValue(workspaceFileAtomFor(workspaceId, path))
  const error = Option.match(AsyncResult.error(result), {
    onNone: () => undefined,
    onSome: (e) => e.message,
  })
  if (error) return <div className={`px-2 py-2 text-[12px] text-danger ${className ?? ""}`}>{error}</div>
  if (!AsyncResult.isSuccess(result)) {
    return <div className={`px-2 py-2 text-[12px] text-fg-dim ${className ?? ""}`}>Loading…</div>
  }
  if (result.value.binary) {
    return <div className={`px-2 py-2 text-[12px] text-fg-dim ${className ?? ""}`}>Binary file — not shown</div>
  }
  return <WorkspaceTextFile workspaceId={workspaceId} path={path} line={line} className={className} onDirtyChange={onDirtyChange} file={result.value} />
}

function WorkspaceTextFile({
  workspaceId,
  path,
  line,
  className,
  onDirtyChange,
  file,
}: WorkspaceFileViewProps & { readonly file: WorkspaceFileContent }): JSX.Element {
  const writeFile = useAtomSet(writeWorkspaceFileAtom, { mode: "promiseExit" })
  const refreshGitStatus = useAtomRefresh(gitStatusAtom(workspaceId))
  const [draft, setDraft] = useState("")
  const [savedText, setSavedText] = useState("")
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | undefined>()
  // A path change (or an external refresh) starts a fresh editing session.
  useEffect(() => {
    setDraft(file.text)
    setSavedText(file.text)
    setSaveError(undefined)
  }, [file.path, file.text])

  const dirty = draft !== savedText
  useEffect(() => onDirtyChange?.(dirty), [dirty, onDirtyChange])
  const canSave = !file.binary && !file.truncated && dirty && !saving
  const save = useCallback((): void => {
    if (!canSave) return
    const text = draft
    setSaving(true)
    setSaveError(undefined)
    void writeFile({ payload: { workspaceId, path, text } }).then((exit) => {
      setSaving(false)
      if (Exit.isSuccess(exit)) {
        setSavedText(text)
        // The main watcher also emits a git-status tick, but a direct editor save
        // should refresh the Changes list immediately rather than wait for its
        // debounce window.
        refreshGitStatus()
      } else {
        setSaveError(Cause.pretty(exit.cause))
      }
    })
  }, [canSave, draft, path, workspaceId, writeFile, refreshGitStatus])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "s") {
        event.preventDefault()
        save()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [save])
  if (file.binary) {
    return (
      <div className={`px-2 py-2 text-[12px] text-fg-dim ${className ?? ""}`}>
        Binary file — not shown
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      <div className="flex items-center gap-2 border-b border-border bg-elev/40 px-2 py-1 text-[11px] text-fg-dim">
        <span className="min-w-0 flex-1 truncate" title={path}>{path}</span>
        {dirty ? <span className="text-warning">Unsaved</span> : null}
        <button
          type="button"
          onClick={save}
          disabled={!canSave}
          className="rounded px-1.5 py-0.5 text-fg hover:bg-elev disabled:cursor-default disabled:opacity-40"
          title="Save (⌘S)"
        >
          {saving ? "Saving…" : "Save"}
        </button>
      </div>
      {saveError ? <div className="border-b border-border px-2 py-1 text-[11px] text-danger">{saveError}</div> : null}
      {file.truncated && (
        <div className="border-b border-border bg-elev/40 px-2 py-1 text-[11px] text-fg-dim">
          File is large — showing the first part only, and saving is disabled
        </div>
      )}
      <CodeEditor
        value={draft}
        language={monacoLanguageId(path)}
        line={line}
        readOnly={file.truncated}
        onChange={setDraft}
        className="min-h-0 flex-1"
      />
    </div>
  )
}
