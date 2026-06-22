import type { JSX, MouseEvent, ReactNode } from "react"
import { arcId, type WorkId } from "../../../shared/ids.js"
import remarkGfm from "remark-gfm"
import { Streamdown } from "streamdown"
import { code } from "@streamdown/code"
import { useShellActions } from "../shell/ShellActionsContext.js"
import { Button } from "./Button.js"

// Styling is Streamdown's own (its Tailwind utilities resolve against our @theme
// tokens) — we only set the prose's base size/color and layout containment on the
// wrapper. The one exception is inline code: Streamdown sizes it at a fixed 14px,
// which looks oversized next to our 12px compact body, so we size it relative to
// the surrounding text instead. (Fenced code blocks are sized down via a
// `[data-streamdown="code-block-body"]` rule in tailwind.css.)
const WORK_ID_PATTERN = /^work_[a-z0-9]+$/i
const HAS_WORK_ID_TEXT_PATTERN = /\bwork_[a-z0-9]+\b/i
const WORK_ID_TEXT_PATTERN = /\bwork_[a-z0-9]+\b/gi

interface MarkdownNode {
  readonly type: string
  readonly value?: string
  children?: Array<MarkdownNode>
  readonly [key: string]: unknown
}

const SKIP_WORK_LINKIFY = new Set([
  "code",
  "definition",
  "inlineCode",
  "link",
  "linkReference",
])

const linkifyWorkIdsInText = (value: string): Array<MarkdownNode> => {
  const nodes: Array<MarkdownNode> = []
  let lastIndex = 0
  for (const match of value.matchAll(WORK_ID_TEXT_PATTERN)) {
    const workId = match[0]
    const index = match.index ?? 0
    if (index > lastIndex) {
      nodes.push({ type: "text", value: value.slice(lastIndex, index) })
    }
    nodes.push({
      type: "link",
      url: `arc://work/${workId}`,
      children: [{ type: "text", value: workId }],
    })
    lastIndex = index + workId.length
  }
  if (lastIndex < value.length) {
    nodes.push({ type: "text", value: value.slice(lastIndex) })
  }
  return nodes
}

const remarkWorkLinks = () => {
  const visit = (node: MarkdownNode): void => {
    if (!node.children || SKIP_WORK_LINKIFY.has(node.type)) return

    const nextChildren: Array<MarkdownNode> = []
    for (const child of node.children) {
      if (child.type === "text" && child.value && HAS_WORK_ID_TEXT_PATTERN.test(child.value)) {
        nextChildren.push(...linkifyWorkIdsInText(child.value))
      } else {
        visit(child)
        nextChildren.push(child)
      }
    }
    node.children = nextChildren
  }

  return visit
}

const components = (onOpenWork?: (workId: WorkId) => void) => ({
  h1: ({ children }: { readonly children?: ReactNode }) => (
    <h1 className="text-sm font-bold">{children}</h1>
  ),
  h2: ({ children }: { readonly children?: ReactNode }) => (
    <h2 className="text-sm font-semibold">{children}</h2>
  ),
  h3: ({ children }: { readonly children?: ReactNode }) => (
    <h3 className="text-xs font-semibold">{children}</h3>
  ),
  a: ({
    children,
    href,
  }: {
    readonly children?: ReactNode
    readonly href?: string
  }) => {
    if (href?.startsWith("arc://work/") && onOpenWork) {
      const workId = arcId("work", href.slice("arc://work/".length))
      return (
        <Button
          variant="link"
          className="font-mono underline"
          onClick={(event: MouseEvent<HTMLButtonElement>) => {
            event.preventDefault()
            onOpenWork(workId)
          }}
        >
          {children}
        </Button>
      )
    }
    return (
      <a href={href} className="text-accent underline">
        {children}
      </a>
    )
  },
  inlineCode: ({ children }: { readonly children?: ReactNode }) => {
    const text = typeof children === "string" ? children : undefined
    if (text && WORK_ID_PATTERN.test(text) && onOpenWork) {
      return (
        <Button
          variant="link"
          className="font-mono underline"
          onClick={() => onOpenWork(arcId("work", text))}
        >
          {text}
        </Button>
      )
    }
    return (
      <code className="text-blue-300">
        {children}
      </code>
    )
  },
})

export function MarkdownBody({
  children,
  streaming = false,
  compact = false,
}: {
  readonly children: string
  readonly streaming?: boolean
  readonly compact?: boolean
}): JSX.Element {
  // Opening a work item is a shell action, pulled from context rather than
  // threaded through every transcript/detail ancestor. Work ids are always
  // linkified — outside a provider (Storybook) the click is a safe no-op.
  const { open } = useShellActions()
  return (
    <Streamdown
      className={`min-w-0 font-mono ${compact ? "text-xs" : "text-sm"} text-foreground [overflow-wrap:anywhere]`}
      mode={streaming ? "streaming" : "static"}
      parseIncompleteMarkdown={streaming}
      components={components((workId) => open({ kind: "work", workId }, "right"))}
      // Passing `remarkPlugins` REPLACES Streamdown's defaults (incl. remark-gfm),
      // so we must re-add gfm ourselves or tables/strikethrough/task-lists stop
      // parsing — see the work-link plugin below.
      remarkPlugins={[remarkGfm, remarkWorkLinks]}
      plugins={{ code }}
      skipHtml
    >
      {children}
    </Streamdown>
  )
}
