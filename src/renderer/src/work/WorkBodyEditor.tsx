// `style.css` is structural only (list markers, placeholder, gap cursor). We
// deliberately skip ProseKit's `typography.css` — its full-page theme sizes h1
// at 40px in a sans font, which is alien next to the pane's compact mono body.
// The look is set below to mirror `MarkdownBody` instead.
import "prosekit/basic/style.css"

import { defineBasicExtension } from "prosekit/basic"
import { createEditor } from "prosekit/core"
import { ProseKit, useDocChange } from "prosekit/react"
import { type JSX, useMemo, useState } from "react"
import { markdownFromDoc, markdownToHtml } from "./markdown.js"

/**
 * Spike: a ProseKit (ProseMirror) rich editor for a work-item body, in place of
 * the plain `<textarea>`. The editor owns a document internally; we keep the
 * persisted shape as markdown by bridging through HTML on both edges (see
 * `markdown.ts`). `onChange` fires on every doc change with the serialised
 * markdown, so the surrounding form can save it like any other field.
 *
 * `defaultMarkdown` seeds the initial document only — the editor is the source
 * of truth after mount, so re-feeding it would clobber the caret. We therefore
 * build the editor once per distinct seed via `useMemo`.
 */
export interface WorkBodyEditorProps {
  readonly defaultMarkdown: string
  readonly onChange: (markdown: string) => void
}

const EDITOR_SHELL =
  "prosekit-body min-h-[12rem] w-full rounded-[var(--radius)] border border-border bg-input px-2 py-1.5 text-[13px] leading-[1.5] text-foreground focus-within:border-accent"

// Mirror `MarkdownBody` (compact): mono, 12px, modest headings, accent links,
// blue inline code. Child selectors keep it scoped to the editor's content.
const EDITOR_CONTENT = [
  "ProseMirror min-h-[10rem] font-mono text-xs leading-[1.5] text-foreground outline-none [overflow-wrap:anywhere]",
  "[&_p]:my-1.5 [&>:first-child]:mt-0 [&>:last-child]:mb-0",
  "[&_h1]:mb-1 [&_h1]:mt-3 [&_h1]:text-sm [&_h1]:font-bold",
  "[&_h2]:mb-1 [&_h2]:mt-3 [&_h2]:text-sm [&_h2]:font-semibold",
  "[&_h3]:mb-1 [&_h3]:mt-3 [&_h3]:text-xs [&_h3]:font-semibold",
  "[&_a]:text-accent [&_a]:underline [&_code]:text-blue-300",
  "[&_blockquote]:my-1.5 [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-2 [&_blockquote]:text-fg-dim",
  "[&_pre]:my-1.5 [&_pre]:rounded-[var(--radius)] [&_pre]:bg-input [&_pre]:p-2",
].join(" ")

function DocSync({ onChange }: { onChange: (markdown: string) => void }): null {
  useDocChange((doc) => onChange(markdownFromDoc(doc)))
  return null
}

export function WorkBodyEditor({ defaultMarkdown, onChange }: WorkBodyEditorProps): JSX.Element {
  // Seed once. After mount the editor owns the document, and our own `onChange`
  // flows the edited markdown back up — re-reading `defaultMarkdown` would
  // rebuild the editor mid-edit and drop the caret. Remount (a new `key`) to
  // switch to a different work item.
  const [seed] = useState(defaultMarkdown)
  const editor = useMemo(
    () => createEditor({ extension: defineBasicExtension(), defaultContent: markdownToHtml(seed) }),
    [seed],
  )

  return (
    <ProseKit editor={editor}>
      <DocSync onChange={onChange} />
      <div className={EDITOR_SHELL}>
        <div ref={editor.mount} className={EDITOR_CONTENT} />
      </div>
    </ProseKit>
  )
}
