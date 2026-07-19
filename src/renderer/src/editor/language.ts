/**
 * Language wiring for the read-only code view. Monaco needs a *registered
 * language id* to attach a tokenizer to, and Shiki needs the matching *grammar
 * name* to colour it — we keep one list (`SHIKI_LANGS`) that is both, so a
 * language is added in exactly one place. `monacoLanguageId` maps a file path to
 * one of those ids by extension, falling back to Monaco's built-in `plaintext`
 * when we don't bundle a grammar for it (an unhighlighted file still renders).
 *
 * The set is deliberately curated, not "every grammar Shiki ships": each one is
 * a grammar Shiki lazy-loads at setup, so the list is the load cost. It covers
 * the languages an arc workspace actually contains; widen it as real files
 * demand, rather than pre-paying for grammars no one opens.
 */

/** Theme shared with the diff view (`@pierre/diffs` renders with the same one),
 * so editor and diff colour source identically. */
export const EDITOR_THEME = "vitesse-dark"

/** Registered with Monaco *and* loaded into Shiki — these strings are both the
 * Monaco language id and the Shiki grammar name (they share a vocabulary). */
export const SHIKI_LANGS = [
  "typescript",
  "tsx",
  "javascript",
  "jsx",
  "json",
  "jsonc",
  "css",
  "html",
  "markdown",
  "python",
  "rust",
  "go",
  "shellscript",
  "yaml",
  "toml",
  "sql",
  "java",
  "c",
  "cpp",
  "ruby",
  "php",
  "swift",
  "kotlin",
  "diff",
  "dockerfile",
] as const

/** Filename extension (no dot, lowercase) → a language id in {@link SHIKI_LANGS}. */
const EXT_TO_LANG: Record<string, string> = {
  ts: "typescript",
  mts: "typescript",
  cts: "typescript",
  tsx: "tsx",
  js: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  jsx: "jsx",
  json: "json",
  jsonc: "jsonc",
  css: "css",
  html: "html",
  htm: "html",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "shellscript",
  bash: "shellscript",
  zsh: "shellscript",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql",
  java: "java",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  kt: "kotlin",
  kts: "kotlin",
  diff: "diff",
  patch: "diff",
}

/** Special-cased filenames whose extension doesn't carry the language. */
const NAME_TO_LANG: Record<string, string> = {
  dockerfile: "dockerfile",
}

/**
 * The Monaco language id for a file path. Reads the basename's extension (and a
 * few extension-less names like `Dockerfile`); anything we don't bundle a
 * grammar for resolves to `plaintext` — the file still opens, just without
 * syntax colour.
 */
export function monacoLanguageId(path: string): string {
  const base = (path.split("/").pop() ?? path).toLowerCase()
  const named = NAME_TO_LANG[base]
  if (named) return named
  const dot = base.lastIndexOf(".")
  const ext = dot >= 0 ? base.slice(dot + 1) : ""
  return EXT_TO_LANG[ext] ?? "plaintext"
}
