import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { JSX } from "react"
import type { WorkspaceId } from "../../../shared/ids.js"
import { workspaceFileAtomFor } from "../atoms.js"
import { CodeEditor } from "./CodeEditor.js"
import { monacoLanguageId } from "./language.js"

export interface WorkspaceFileViewProps {
  readonly workspaceId: WorkspaceId
  /** Relative POSIX path within the workspace, as returned by `ListWorkspaceFiles`. */
  readonly path: string
  /** 1-based line to reveal, when the opener carried one (`foo.ts:7`). */
  readonly line?: number
  readonly className?: string
}

/**
 * The atom-backed read-only editor: pulls one workspace file over the RPC seam
 * (`ReadWorkspaceFile`) and renders it in {@link CodeEditor}, with the language
 * inferred from the path. Loading and failure fall back to a one-line message
 * the same way the diff view does; a binary or truncated body is flagged rather
 * than shown as garbage or implied complete.
 */
export function WorkspaceFileView({
  workspaceId,
  path,
  line,
  className,
}: WorkspaceFileViewProps): JSX.Element {
  const result = useAtomValue(workspaceFileAtomFor(workspaceId, path))
  const error = Option.match(AsyncResult.error(result), {
    onNone: () => undefined,
    onSome: (e) => e.message,
  })

  if (error) {
    return <div className={`px-2 py-2 text-[12px] text-danger ${className ?? ""}`}>{error}</div>
  }
  if (!AsyncResult.isSuccess(result)) {
    return <div className={`px-2 py-2 text-[12px] text-fg-dim ${className ?? ""}`}>Loading…</div>
  }

  const file = result.value
  if (file.binary) {
    return (
      <div className={`px-2 py-2 text-[12px] text-fg-dim ${className ?? ""}`}>
        Binary file — not shown
      </div>
    )
  }

  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      {file.truncated && (
        <div className="border-b border-border bg-elev/40 px-2 py-1 text-[11px] text-fg-dim">
          File is large — showing the first part only
        </div>
      )}
      <CodeEditor
        value={file.text}
        language={monacoLanguageId(path)}
        line={line}
        className="min-h-0 flex-1"
      />
    </div>
  )
}
