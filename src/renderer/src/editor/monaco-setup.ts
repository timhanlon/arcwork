import { shikiToMonaco } from "@shikijs/monaco"
import * as monaco from "monaco-editor-core"
// `monaco-editor-core`, not `monaco-editor`: the bare editor with NO bundled
// language services. The full package ships TS/JSON/CSS language *features* that
// post to per-language workers; with only the base worker wired they throw
// "Missing requestHandler". We don't want them anyway — Shiki does all
// tokenising, and real language intelligence comes later over LSP. So the base
// editor worker is the only one, and nothing reaches for a missing one.
// Vite's `?worker` import bundles it locally (offline Electron app, never a CDN).
// oxlint can't resolve the virtual `?worker` module's default export (Vite supplies it).
// eslint-disable-next-line import/default
import editorWorker from "monaco-editor-core/esm/vs/editor/editor.worker.start?worker"
import { createHighlighter } from "shiki"
import { EDITOR_THEME, SHIKI_LANGS } from "./language.js"

/**
 * Monaco needs one-time global setup before any editor is created: a worker
 * factory, language registrations, and a tokeniser per language. We do it once,
 * memoised behind a promise — every `CodeEditor` awaits the same `getMonaco()`
 * so the highlighter is built a single time no matter how many files open. The
 * resolved value is the Monaco namespace itself, so callers don't re-import it.
 */
let setup: Promise<typeof monaco> | undefined

export function getMonaco(): Promise<typeof monaco> {
  setup ??= initialize()
  return setup
}

async function initialize(): Promise<typeof monaco> {
  self.MonacoEnvironment = {
    getWorker: () => new editorWorker(),
  }

  // Register each id so Monaco has a language to hang the Shiki grammar on — for
  // ids Monaco already ships (typescript, json) this is an idempotent no-op; for
  // the ones it doesn't (tsx, shellscript, toml, …) it's what makes them colour.
  for (const id of SHIKI_LANGS) {
    monaco.languages.register({ id })
  }
  const highlighter = await createHighlighter({
    themes: [EDITOR_THEME],
    langs: [...SHIKI_LANGS],
  })
  // Replaces Monaco's default Monarch tokeniser for each registered language with
  // Shiki's TextMate grammar, so the editor colours exactly like the diff view.
  shikiToMonaco(highlighter, monaco)
  return monaco
}
