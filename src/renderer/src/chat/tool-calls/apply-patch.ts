// Pure parsing for Codex `apply_patch` bodies — no React, so it's unit-testable
// in isolation. A patch body is the `*** Begin Patch … *** End Patch` envelope
// wrapping one or more per-file edits; this turns it into before/after pairs the
// diff renderer can consume.

export interface PatchFileEdit {
  readonly path: string
  readonly oldStr: string
  readonly newStr: string
}

const trimApplyPatchWrapper = (patch: string): string => {
  const lines = patch.split("\n")
  const start = lines.findIndex((line) => line === "*** Begin Patch")
  const end = lines.findIndex((line) => line === "*** End Patch")
  return lines.slice(start >= 0 ? start + 1 : 0, end >= 0 ? end : lines.length).join("\n")
}

const flushPatchEdit = (
  edits: Array<PatchFileEdit>,
  path: string | null,
  oldLines: Array<string>,
  newLines: Array<string>,
): void => {
  if (!path) return
  edits.push({ path, oldStr: oldLines.join("\n"), newStr: newLines.join("\n") })
}

export const parseApplyPatchEdits = (patch: string): ReadonlyArray<PatchFileEdit> => {
  const edits: Array<PatchFileEdit> = []
  const lines = trimApplyPatchWrapper(patch).split("\n")
  let path: string | null = null
  let oldLines: Array<string> = []
  let newLines: Array<string> = []
  let mode: "add" | "delete" | "update" | null = null

  const flush = (): void => {
    flushPatchEdit(edits, path, oldLines, newLines)
    path = null
    oldLines = []
    newLines = []
    mode = null
  }

  for (const line of lines) {
    if (line.startsWith("*** Add File: ")) {
      flush()
      path = line.slice("*** Add File: ".length)
      mode = "add"
      continue
    }
    if (line.startsWith("*** Delete File: ")) {
      flush()
      path = line.slice("*** Delete File: ".length)
      mode = "delete"
      continue
    }
    if (line.startsWith("*** Update File: ")) {
      flush()
      path = line.slice("*** Update File: ".length)
      mode = "update"
      continue
    }
    if (line.startsWith("*** Move to: ")) {
      const movedPath = line.slice("*** Move to: ".length)
      flushPatchEdit(edits, path, oldLines, [])
      path = movedPath
      oldLines = []
      newLines = []
      mode = "add"
      continue
    }
    if (!mode || line === "@@" || line.startsWith("@@ ")) continue

    if (mode === "add") {
      if (line.startsWith("+")) newLines.push(line.slice(1))
      continue
    }
    if (mode === "delete") {
      if (!line.startsWith("***")) oldLines.push(line.startsWith("-") ? line.slice(1) : line)
      continue
    }
    if (line.startsWith("-")) {
      oldLines.push(line.slice(1))
    } else if (line.startsWith("+")) {
      newLines.push(line.slice(1))
    } else if (!line.startsWith("***")) {
      oldLines.push(line.startsWith(" ") ? line.slice(1) : line)
      newLines.push(line.startsWith(" ") ? line.slice(1) : line)
    }
  }
  flush()
  return edits
}
