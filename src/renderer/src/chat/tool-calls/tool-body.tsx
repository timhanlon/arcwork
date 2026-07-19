import { parseDiffFromFile } from "@pierre/diffs"
import { FileDiff } from "@pierre/diffs/react"
import type { JSX, ReactNode } from "react"
import { useLayoutEffect, useMemo, useRef, useState } from "react"
import type { Provider } from "../../../../shared/provider.js"
import type { ToolCallImage } from "../../../../shared/tool-call.js"
import { arcImgCacheSrc } from "../../../../shared/images.js"
import { renderShapeFor } from "../../../../shared/tool-catalog.js"
import { tildify } from "../../format-path.js"
import { Button } from "../../ui/Button.js"
import { Label } from "../../ui/Label.js"
import { DIFF_THEME, useDiffHighlighterReady } from "../../ui/useDiffHighlighter.js"
import { parseApplyPatchEdits } from "./apply-patch.js"

// Shared per-tool argument rendering. Both the permission card (the decision the
// user is approving) and the projected tool-call row (the execution that
// happened) show the same shapes — a Bash command, a Write body, an Edit diff,
// a file path — so the rendering lives here and both components reuse it.

// Split so the box and the text live on different elements: the frame (border +
// surface + padding) wraps the {@link Collapsible}'s clipped content, while the
// fade mask only ever touches the text. Keeping the border off the masked
// element stops the dissolve from eating the box's bottom/side edges.
export const CODE_FRAME = "border border-border bg-input px-2.5 py-2"
const CODE_TEXT = "m-0 text-fg-dim font-mono text-[11px] leading-[1.45] whitespace-pre-wrap break-words"
const PATH = "font-mono text-[11px] text-foreground [overflow-wrap:anywhere]"
// A small flag chip (e.g. background, replace all) sitting beside the tool name.
export const FLAG =
  "flex-none px-1.5 py-px border border-border rounded-[var(--radius)] font-mono text-[9px] uppercase tracking-[0.06em] text-fg-dim"

export const obj = (value: unknown): Record<string, unknown> | null =>
  typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null

export const str = (value: unknown): string | null => (typeof value === "string" ? value : null)

export const formatArgs = (args: unknown): string | null => {
  if (args === undefined || args === null) return null
  if (typeof args === "string") return args
  try {
    return JSON.stringify(args, null, 2)
  } catch {
    return String(args)
  }
}

export const stripDescription = (a: Record<string, unknown>): Record<string, unknown> => {
  const { description: _description, ...rest } = a
  return rest
}

/** Fade band height stays a fraction of the cap so the dissolve scales with how
 * much content shows — a fixed floor swallowed most of a short subagent card. */
const fadeHeightFor = (collapsedHeight: number): number =>
  Math.round(Math.min(48, Math.max(16, collapsedHeight * 0.3)))

/**
 * Caps tall content to a pixel height, fading out at the cut with a "show
 * more"/"show less" toggle, so a 60-line heredoc, a whole written file, or a
 * subagent's full prompt doesn't dominate the transcript. Collapsing by pixel
 * height (not line count) keeps the cut visually consistent across short and
 * wrapped lines. The cut is a CSS mask that fades the content's own bottom edge
 * to transparent, so it dissolves into whatever card sits behind it — no need to
 * tell it the surface color.
 */
export function Collapsible({
  children,
  collapsedHeight = 120,
  frameClassName,
}: {
  readonly children: ReactNode
  readonly collapsedHeight?: number
  /** Optional border/surface for the clipped content. It wraps the masked
   * element rather than carrying the mask itself, so a bordered block keeps
   * crisp edges instead of dissolving into the fade. Omit for plain prose, which
   * is meant to fade straight into the card behind it. */
  readonly frameClassName?: string
}): JSX.Element {
  const ref = useRef<HTMLDivElement>(null)
  const [overflows, setOverflows] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // Content can change after mount (streaming body), so observe the element and
  // re-measure on every size change. setState bails when the value is unchanged.
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setOverflows(el.scrollHeight > collapsedHeight + 1)
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    return () => observer.disconnect()
  }, [collapsedHeight])

  const collapsed = overflows && !expanded
  const fadeHeight = fadeHeightFor(collapsedHeight)
  const fadeMask = `linear-gradient(to bottom, #000 calc(100% - ${fadeHeight}px), transparent 100%)`
  // The clip + mask only ever sit on this inner element (the text). The frame, if
  // any, wraps it and stays unmasked, so the box edges render crisp while the
  // text dissolves at the cut.
  const clipped = (
    <div
      ref={ref}
      className="min-w-0"
      style={
        collapsed
          ? {
              maxHeight: collapsedHeight,
              overflow: "hidden",
              WebkitMaskImage: fadeMask,
              maskImage: fadeMask,
            }
          : undefined
      }
    >
      {children}
    </div>
  )
  return (
    <div className="grid min-w-0">
      {frameClassName ? (
        <div className={`min-w-0 ${frameClassName}`}>{clipped}</div>
      ) : (
        <div className="relative min-w-0">{clipped}</div>
      )}
      {overflows && (
        <Button
          variant="quiet"
          size="sm"
          className="mt-1 uppercase tracking-[0.06em] select-none"
          onClick={() => setExpanded((value) => !value)}
        >
          {expanded ? "show less" : "show more"}
        </Button>
      )}
    </div>
  )
}

/**
 * Code/argument block that reveals real newlines (the raw `JSON.stringify` dump
 * escaped them, so a multi-line command or file body rendered as one unreadable
 * line), capping its rendered height via {@link Collapsible}.
 */
export function CodeBlock({
  text,
  collapsedHeight = 120,
  frameClassName = CODE_FRAME,
}: {
  readonly text: string
  readonly collapsedHeight?: number
  /** Border/surface for the box; the text styling is fixed (`CODE_TEXT`). */
  readonly frameClassName?: string
}): JSX.Element {
  return (
    <Collapsible collapsedHeight={collapsedHeight} frameClassName={frameClassName}>
      <pre className={CODE_TEXT}>{text}</pre>
    </Collapsible>
  )
}

/**
 * The pictures a tool result carried (a Read of a `.png`, a browser screenshot),
 * rendered inline in place of the old `[image]` text. Each is served from the
 * content-addressed ingest cache via the `arc-img://` protocol, capped to a
 * thumbnail height; `onOpen` (when given) opens the full picture in the viewer
 * pane. A load failure (cache miss) collapses the element rather than showing a
 * broken-image glyph.
 */
export function ImageOutput({
  images,
  onOpen,
}: {
  readonly images: ReadonlyArray<ToolCallImage>
  readonly onOpen?: (src: string) => void
}): JSX.Element {
  return (
    <div className="flex flex-wrap gap-2 min-w-0">
      {images.map((image) => {
        const src = arcImgCacheSrc(image.hash, image.mediaType)
        return (
          <img
            key={image.hash}
            src={src}
            alt=""
            loading="lazy"
            onClick={onOpen ? () => onOpen(src) : undefined}
            onError={(event) => {
              event.currentTarget.style.display = "none"
            }}
            className={`max-h-64 max-w-full rounded-[var(--radius)] border border-border object-contain ${
              onOpen ? "cursor-zoom-in" : ""
            }`}
          />
        )
      })}
    </div>
  )
}

const Field = ({ label, children }: { readonly label: string; readonly children: ReactNode }): JSX.Element => (
  <div className="flex items-baseline gap-1.5 min-w-0">
    <Label kind="meta">{label}</Label>
    <span className={PATH}>{children}</span>
  </div>
)

// Filename drives Shiki's language inference for the diff. Edit args may omit a
// path, so fall back to a plain-text name.
const diffName = (path: string | null): string => (path ? (path.split("/").pop() ?? path) : "edit.txt")

/**
 * An Edit's before/after rendered as a real unified diff via `@pierre/diffs`:
 * syntax-highlit, line-level change detection (so an edit that only touches part
 * of a block highlights just the changed spans, not the whole before/after). The
 * old hand-rolled two-block version showed every line as fully removed+added.
 * Display-only — no line numbers (these are fragments, not whole files) and no
 * file header (the path is already shown above). Highlighting runs on the main
 * thread (`disableWorkerPool`) since these diffs are tiny and it avoids wiring a
 * worker pool into the Electron renderer.
 */
function EditDiff({
  path,
  oldStr,
  newStr,
}: {
  readonly path: string | null
  readonly oldStr: string
  readonly newStr: string
}): JSX.Element | null {
  const highlighterReady = useDiffHighlighterReady()
  const name = diffName(path)
  const fileDiff = useMemo(
    () =>
      // Newline-terminate both sides so jsdiff (via parseDiffFromFile) doesn't
      // emit a spurious "\ No newline at end of file" marker — these are edit
      // fragments, not real files, and the marker just means "no trailing \n".
      parseDiffFromFile(
        { name, contents: oldStr.endsWith("\n") ? oldStr : `${oldStr}\n` },
        { name, contents: newStr.endsWith("\n") ? newStr : `${newStr}\n` },
      ),
    [name, oldStr, newStr],
  )
  if (!highlighterReady) return null
  return (
    <FileDiff
      fileDiff={fileDiff}
      disableWorkerPool
      className="min-w-0 text-[11px]"
      options={{
        theme: DIFF_THEME,
        themeType: "dark",
        diffStyle: "unified",
        disableLineNumbers: true,
        disableFileHeader: true,
        overflow: "wrap",
        // Force Shiki's pure-JS engine. The default WASM (oniguruma) engine
        // never resolves in the Electron renderer, so the async highlight that
        // fills the diff's <pre> hangs and the card renders empty/0-height.
        preferredHighlighter: "shiki-js",
      }}
    />
  )
}

const patchBody = (a: Record<string, unknown>): string | null => str(a["command"]) ?? str(a["input"])

// Cross-provider argument extractors. The same render shape ships under
// different arg-key spellings per target — codex's shell uses `cmd` not
// `command`, cursor's Write uses `contents`/`path` not `content`/`file_path`,
// cursor's Grep scopes by `glob` and its Glob by `glob_pattern` — so each shape
// reads from every spelling its providers use.
const filePathOf = (a: Record<string, unknown>): string | null =>
  str(a["file_path"]) ?? str(a["path"]) ?? str(a["notebook_path"])

// A shell command is a plain string (Claude/Cursor `command`, Codex `cmd`) or an
// argv array (Codex's `local_shell` form, `["bash","-lc","…"]`), joined back to a
// readable line.
const commandOf = (a: Record<string, unknown>): string | null => {
  const command = a["command"]
  if (typeof command === "string") return command
  if (Array.isArray(command) && command.every((part) => typeof part === "string")) return command.join(" ")
  return str(a["cmd"])
}

/**
 * A before/after edit rendered as a diff. Two arg shapes converge here: an
 * Edit/StrReplace's `old_string`/`new_string` pair (one file), or a Codex
 * `apply_patch` body (`*** Begin Patch …`) parsed into per-file diffs. Returns
 * null when neither shape is present so the caller can fall back to JSON.
 */
function diffBody(a: Record<string, unknown>): JSX.Element | null {
  const oldStr = str(a["old_string"]) ?? str(a["old_str"])
  const newStr = str(a["new_string"]) ?? str(a["new_str"])
  if (oldStr != null || newStr != null) {
    const path = filePathOf(a)
    return (
      <>
        {path && <Field label="file">{tildify(path)}</Field>}
        <EditDiff path={path} oldStr={oldStr ?? ""} newStr={newStr ?? ""} />
      </>
    )
  }
  const patch = patchBody(a)
  const edits = patch ? parseApplyPatchEdits(patch) : []
  if (edits.length === 0) return null
  return (
    <div className="grid gap-2 min-w-0">
      {edits.map((edit) => (
        <div key={`${edit.path}:${edit.oldStr}`} className="grid gap-1.5 min-w-0">
          <Field label="file">{tildify(edit.path)}</Field>
          <EditDiff path={edit.path} oldStr={edit.oldStr} newStr={edit.newStr} />
        </div>
      ))}
    </div>
  )
}

/**
 * Per-tool argument rendering, dispatched on the (provider, tool)'s render shape
 * from the shared catalog rather than a name switch: shell tools show their
 * command, Write its target + body, Edit/patch a before/after diff, file tools
 * their path. Returns null when the shape is `fallback` (or its args are empty),
 * so the caller can fall back to formatted JSON. A plain function (not a
 * component) so the caller can branch on the null instead of an always-truthy
 * element.
 */
export function toolBody(provider: Provider | undefined, toolName: string, args: unknown): JSX.Element | null {
  const a = obj(args)
  if (!a) return null
  switch (renderShapeFor(provider, toolName)) {
    case "shell": {
      const command = commandOf(a)
      return command ? <CodeBlock text={command} /> : null
    }
    case "write": {
      const path = filePathOf(a)
      const content = str(a["content"]) ?? str(a["contents"])
      return (
        <>
          {path && <Field label="file">{tildify(path)}</Field>}
          {content != null && <CodeBlock text={content} />}
        </>
      )
    }
    case "diff":
      return diffBody(a)
    case "path": {
      const pattern = str(a["pattern"]) ?? str(a["glob_pattern"])
      const path = filePathOf(a) ?? str(a["glob"])
      if (!pattern && !path) return null
      return (
        <>
          {pattern && <Field label="pattern">{pattern}</Field>}
          {path && <Field label={pattern ? "path" : "file"}>{tildify(path)}</Field>}
        </>
      )
    }
    case "fallback":
      return null
  }
}

export const flagsFor = (args: unknown): ReadonlyArray<string> => {
  const a = obj(args)
  if (!a) return []
  const flags: Array<string> = []
  if (a["run_in_background"] === true) flags.push("background")
  if (a["replace_all"] === true) flags.push("replace all")
  return flags
}
