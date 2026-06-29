import type { ComponentProps, JSX, ReactNode } from "react"
import remarkGfm from "remark-gfm"
import { Streamdown } from "streamdown"
import { code } from "@streamdown/code"
import { mermaid } from "@streamdown/mermaid"

export type StreamdownProps = ComponentProps<typeof Streamdown>

// Styling is Streamdown's own (its Tailwind utilities resolve against our @theme
// tokens) — we only set the prose's base size/color and layout containment on the
// wrapper, plus modest headings and the inline-code/link treatment. The one
// exception is inline code: Streamdown sizes it at a fixed 14px, which looks
// oversized next to our 12px compact body, so we size it relative to the
// surrounding text instead. (Fenced code blocks are sized down via a
// `[data-streamdown="code-block-body"]` rule in tailwind.css.)
export const baseComponents = {
  h1: ({ children }: { readonly children?: ReactNode }) => (
    <h1 className="text-sm font-bold">{children}</h1>
  ),
  h2: ({ children }: { readonly children?: ReactNode }) => (
    <h2 className="text-sm font-semibold">{children}</h2>
  ),
  h3: ({ children }: { readonly children?: ReactNode }) => (
    <h3 className="text-xs font-semibold">{children}</h3>
  ),
  a: ({ children, href }: { readonly children?: ReactNode; readonly href?: string }) => (
    <a href={href} className="text-accent underline">
      {children}
    </a>
  ),
  inlineCode: ({ children }: { readonly children?: ReactNode }) => (
    <code className="text-blue-300">{children}</code>
  ),
}

/**
 * The renderer's domain-free Markdown primitive (a `Components /` story): base
 * prose styling over Streamdown, with GFM, code, and mermaid wired in. `compact`
 * shrinks the type for inline/chat surfaces; `streaming` enables incremental
 * parsing of a half-arrived string.
 *
 * Callers replace the component set via `components` (build on {@link
 * baseComponents} to keep the base styling) and add extra `remarkPlugins`
 * (appended after the required `remark-gfm` — passing `remarkPlugins` to
 * Streamdown directly would REPLACE gfm and silently drop
 * tables/strikethrough/task-lists). `rehypePlugins`, by contrast, REPLACES
 * Streamdown's default raw→sanitize→harden chain wholesale (Streamdown only
 * falls back to its default when the prop is absent), so a caller passing it
 * owns the full chain — recompose from `defaultRehypePlugins` rather than
 * hand-rolling. The work-aware wrapper that linkifies `work_*` ids lives in
 * `work/WorkMarkdown`, so nothing domain-specific leaks into `ui/`.
 */
export function Markdown({
  children,
  streaming = false,
  compact = false,
  components,
  remarkPlugins,
  rehypePlugins,
}: {
  readonly children: string
  readonly streaming?: boolean
  readonly compact?: boolean
  readonly components?: StreamdownProps["components"]
  readonly remarkPlugins?: StreamdownProps["remarkPlugins"]
  readonly rehypePlugins?: StreamdownProps["rehypePlugins"]
}): JSX.Element {
  return (
    <Streamdown
      className={`min-w-0 font-mono ${compact ? "text-xs" : "text-sm"} text-foreground [overflow-wrap:anywhere]`}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      components={components ?? baseComponents}
      remarkPlugins={[remarkGfm, ...(remarkPlugins ?? [])]}
      rehypePlugins={rehypePlugins}
      plugins={{ code, mermaid }}
      skipHtml
    >
      {children}
    </Streamdown>
  )
}
