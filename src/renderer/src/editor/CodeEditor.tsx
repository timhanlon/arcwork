import type { editor } from "monaco-editor-core"
import { type JSX, useEffect, useRef } from "react"
import { EDITOR_THEME } from "./language.js"
import { getMonaco } from "./monaco-setup.js"

export interface CodeEditorProps {
  /** The file body to show. Pushed into the model on change without recreating
   * the editor, so switching files keeps the instance (and its workers) warm. */
  readonly value: string
  /** A Monaco language id — use {@link monacoLanguageId} to derive it from a path.
   * `plaintext` is always valid (renders uncoloured). */
  readonly language: string
  /** 1-based line to reveal (centered) and place the caret on, e.g. from a
   * `foo.ts:7` link. Re-revealed when it changes so re-opening the same file at a
   * different line jumps again. */
  readonly line?: number
  /** Enable editing and receive Monaco model changes. Defaults to the existing
   * safe preview behaviour, so callers opt into writes deliberately. */
  readonly readOnly?: boolean
  readonly onChange?: (value: string) => void
  readonly className?: string
}

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
  readOnly: true,
  // `domReadOnly` also blocks the textarea so the caret/keyboard can't mutate it
  // — read-only at the DOM level, not just Monaco's command layer.
  domReadOnly: true,
  // Monaco doesn't reflow on container resize on its own; this ticks a layout
  // pass so the editor tracks the pane (and Storybook canvas) without a manual
  // ResizeObserver.
  automaticLayout: true,
  minimap: { enabled: false },
  scrollBeyondLastLine: false,
  fontSize: 12,
  lineHeight: 18,
  fontFamily: "var(--mono)",
  // The pane supplies its own chrome; keep the editor itself flush.
  padding: { top: 8, bottom: 8 },
  renderLineHighlight: "none",
  scrollbar: { useShadows: false },
}

/** Center `line` (1-based) in the viewport and place the caret there. No-op when
 * the editor isn't ready or no line was requested. */
const revealLine = (ed: editor.IStandaloneCodeEditor | undefined, line: number | undefined): void => {
  if (!ed || !line) return
  ed.revealLineInCenter(line)
  ed.setPosition({ lineNumber: line, column: 1 })
}

/**
 * A read-only Monaco view of one file. The widget is created once on mount and
 * disposed on unmount; `value`/`language` flow into the existing model so a file
 * switch doesn't tear down and rebuild Monaco. Highlighting is Shiki's (see
 * `monaco-setup`), themed to match the diff view. This component is pure — it
 * takes text, not a workspace id — so it renders in Storybook with a fixture;
 * `WorkspaceFileView` is the atom-backed wrapper that feeds it real files.
 */
export function CodeEditor({ value, language, line, readOnly = true, onChange, className }: CodeEditorProps): JSX.Element {
  const hostRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<editor.IStandaloneCodeEditor | undefined>(undefined)
  // Latest props, read when `getMonaco()` resolves. The first-ever create waits on
  // the one-time Shiki highlighter build (~1–2s); a file switch or line change that
  // lands inside that window would otherwise be lost — the update effects below
  // no-op while `editorRef` is still undefined, and a mount-only closure would bake
  // in the props as they were at mount. Creating from `latest` closes that gap.
  const latest = useRef({ value, language, line, readOnly })
  latest.current = { value, language, line, readOnly }
  const onChangeRef = useRef(onChange)
  onChangeRef.current = onChange

  // Create once. `getMonaco()` is async (it builds the Shiki highlighter), so a
  // fast unmount can resolve after teardown — `disposed` guards that race.
  useEffect(() => {
    let disposed = false
    void getMonaco().then((monaco) => {
      if (disposed || !hostRef.current) return
      editorRef.current = monaco.editor.create(hostRef.current, {
        ...EDITOR_OPTIONS,
        readOnly: latest.current.readOnly,
        domReadOnly: latest.current.readOnly,
        value: latest.current.value,
        language: latest.current.language,
        theme: EDITOR_THEME,
      })
      editorRef.current.onDidChangeModelContent(() => onChangeRef.current?.(editorRef.current?.getValue() ?? ""))
      // The model has its content at construction, so an initial `foo.ts:7` line
      // can be revealed straight away.
      revealLine(editorRef.current, latest.current.line)
    })
    return () => {
      disposed = true
      editorRef.current?.dispose()
      editorRef.current = undefined
    }
    // Mount-only: subsequent value/language changes are handled below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Reflect a new file body into the live model. `setValue` works under
  // `readOnly` (that gate is for user input, not the API); guard on equality so
  // re-renders with the same text don't reset the scroll position.
  useEffect(() => {
    const model = editorRef.current?.getModel()
    if (model && model.getValue() !== value) {
      model.setValue(value)
    }
  }, [value])

  useEffect(() => {
    editorRef.current?.updateOptions({ readOnly, domReadOnly: readOnly })
  }, [readOnly])

  // Re-reveal when the target line changes — re-opening the same (already mounted)
  // file at a different line jumps again, without recreating the editor.
  useEffect(() => {
    revealLine(editorRef.current, line)
  }, [line])

  // Retag the model's language when the file type changes. Static helper off the
  // same Monaco singleton `getMonaco()` configured, so the Shiki grammar for the
  // new id is already registered by the time we can reach this.
  useEffect(() => {
    void getMonaco().then((monaco) => {
      const model = editorRef.current?.getModel()
      if (model && model.getLanguageId() !== language) {
        monaco.editor.setModelLanguage(model, language)
      }
    })
  }, [language])

  return <div ref={hostRef} className={className} />
}
