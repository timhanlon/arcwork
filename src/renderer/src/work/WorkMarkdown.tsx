import type { JSX, MouseEvent, ReactNode } from "react"
import { arcId, type WorkId } from "../../../shared/ids.js"
import { Markdown, baseComponents } from "../ui/Markdown.js"
import { Button } from "../ui/Button.js"
import { useShellActions } from "../shell/ShellActionsContext.js"

const WORK_ID_PATTERN = /^work_[a-z0-9]+$/i
const HAS_WORK_ID_TEXT_PATTERN = /\bwork_[a-z0-9]+\b/i
const WORK_ID_TEXT_PATTERN = /\bwork_[a-z0-9]+\b/gi

interface MarkdownNode {
  readonly type: string
  readonly value?: string
  children?: Array<MarkdownNode>
  readonly [key: string]: unknown
}

const SKIP_WORK_LINKIFY = new Set(["code", "definition", "inlineCode", "link", "linkReference"])

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

const workComponents = (onOpenWork: (workId: WorkId) => void) => ({
  ...baseComponents,
  a: ({ children, href }: { readonly children?: ReactNode; readonly href?: string }) => {
    if (href?.startsWith("arc://work/")) {
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
    if (text && WORK_ID_PATTERN.test(text)) {
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
    return <code className="text-blue-300">{children}</code>
  },
})

/**
 * The domain-aware Markdown surface for chat/work bodies: the {@link Markdown}
 * primitive plus a remark plugin that linkifies bare `work_*` ids and an
 * `a`/`inlineCode` override that turns them into buttons opening the work pane.
 *
 * Opening a work item is a shell action, pulled from context rather than
 * threaded through every transcript/detail ancestor. Work ids are always
 * linkified — outside a provider (Storybook) the click is a safe no-op.
 */
export function WorkMarkdown({
  children,
  streaming = false,
  compact = false,
}: {
  readonly children: string
  readonly streaming?: boolean
  readonly compact?: boolean
}): JSX.Element {
  const { open } = useShellActions()
  return (
    <Markdown
      compact={compact}
      streaming={streaming}
      components={workComponents((workId) => open({ kind: "work", workId }, "right"))}
      remarkPlugins={[remarkWorkLinks]}
    >
      {children}
    </Markdown>
  )
}
