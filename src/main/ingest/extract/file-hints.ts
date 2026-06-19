/**
 * Best-effort file path extraction from tool inputs. These are hints — paths a
 * turn *mentioned*, not proof a file changed. Confidence reflects how directly
 * the path was named: an explicit `file_path` field is "high"; a path scraped
 * from a shell command is "low".
 */

export interface PathHint {
  readonly path: string
  /** Where the hint came from: a tool input field, an apply_patch marker, etc. */
  readonly source: string
  readonly confidence: "high" | "medium" | "low"
}

/** Tool-input fields that, when present, directly name a target file. */
const PATH_FIELDS = ["file_path", "path", "filename", "file", "notebook_path"]

const dedupe = (hints: ReadonlyArray<PathHint>): ReadonlyArray<PathHint> => {
  const seen = new Set<string>()
  const out: Array<PathHint> = []
  for (const hint of hints) {
    if (seen.has(hint.path)) continue
    seen.add(hint.path)
    out.push(hint)
  }
  return out
}

/**
 * Parse Codex `apply_patch` body text for the files it touches. Markers look
 * like `*** Add File: path`, `*** Update File: path`, `*** Delete File: path`,
 * and `*** New Name: path` (for renames).
 */
export const pathsFromApplyPatch = (patchText: string): ReadonlyArray<string> => {
  const markers = [
    "*** Add File:",
    "*** Create File:",
    "*** Update File:",
    "*** Modify File:",
    "*** Delete File:",
    "*** Remove File:",
    "*** Rename File:",
    "*** New Name:",
  ]
  const paths: Array<string> = []
  for (const raw of patchText.split("\n")) {
    const line = raw.trim()
    for (const marker of markers) {
      if (line.startsWith(marker)) {
        const path = line.slice(marker.length).trim()
        if (path.length > 0) paths.push(path)
        break
      }
    }
  }
  return paths
}

const asString = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value : undefined

const recordOf = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined

/**
 * Derive path hints from a tool's name and decoded input object. Handles the
 * common direct-field tools, Codex `apply_patch`, and a light scrape of shell
 * command strings for obvious file arguments.
 */
export const hintsFromToolInput = (
  name: string | null | undefined,
  input: Record<string, unknown> | null | undefined,
): ReadonlyArray<PathHint> => {
  if (!input) return []
  const hints: Array<PathHint> = []

  const toolName = (name ?? "").toLowerCase()

  if (toolName === "apply_patch") {
    const body = asString(input["input"]) ?? asString(input["patch"]) ?? ""
    for (const path of pathsFromApplyPatch(body)) {
      hints.push({ path, source: "apply_patch", confidence: "high" })
    }
  }

  for (const field of PATH_FIELDS) {
    const value = asString(input[field])
    if (value) hints.push({ path: value, source: `tool_input.${field}`, confidence: "high" })
  }

  // Edit/MultiEdit and Cursor MultiStrReplace carry arrays of objects with paths.
  for (const field of ["edits", "paths"]) {
    const list = input[field]
    if (!Array.isArray(list)) continue
    for (const item of list) {
      const filePath = asString(recordOf(item)?.["file_path"])
      if (filePath) hints.push({ path: filePath, source: `tool_input.${field}`, confidence: "high" })
    }
  }

  // Light shell scrape: pull token-looking paths out of a command string.
  const command = asString(input["command"]) ?? asString(input["cmd"])
  if (command) {
    for (const path of pathsFromShellCommand(command)) {
      hints.push({ path, source: "shell_command", confidence: "low" })
    }
  }

  return dedupe(hints)
}

/** Extract path-shaped tokens (containing a `/` and a likely filename) from a shell command. */
const pathsFromShellCommand = (command: string): ReadonlyArray<string> => {
  const paths: Array<string> = []
  for (const rawToken of command.split(/\s+/)) {
    const token = rawToken.replace(/^['"]|['"]$/g, "")
    if (token.startsWith("-")) continue
    // Require a slash and a dotted filename segment to avoid flag/word noise.
    if (token.includes("/") && /\.[A-Za-z0-9]+$/.test(token)) {
      paths.push(token)
    }
  }
  return paths
}
