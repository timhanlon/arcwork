import { type JSX, type MouseEvent, type ReactNode, useMemo } from "react"
import { defaultRehypePlugins } from "streamdown"
import { arcId, type WorkId } from "../../../shared/ids.js"
import { Markdown, baseComponents, type StreamdownProps } from "../ui/Markdown.js"
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

type RehypePlugins = NonNullable<StreamdownProps["rehypePlugins"]>
type Pluggable = RehypePlugins[number]
/** The `[plugin, ...options]` tuple form of a Pluggable; `[0]` is the plugin. */
type PluginTuple = Extract<Pluggable, ReadonlyArray<unknown>>

/** The subset of rehype-sanitize's schema we touch: its per-attribute URL
 * protocol allow-list. The rest of the schema is preserved untouched. */
interface SanitizeSchema {
  readonly protocols?: { readonly href?: ReadonlyArray<string> }
  readonly [key: string]: unknown
}

/** Add `arc` to the sanitize schema's allowed `href` protocols, leaving the
 * plugin and every other rule as-is. The `[plugin, schema]` shape is Streamdown's
 * (`defaultRehypePlugins.sanitize`); a bare-plugin entry is returned untouched. */
const allowArcHrefProtocol = (sanitize: Pluggable): Pluggable => {
  if (!Array.isArray(sanitize)) return sanitize
  const [plugin, schema, ...rest] = sanitize as [PluginTuple[0], SanitizeSchema, ...ReadonlyArray<unknown>]
  const href = schema.protocols?.href ?? []
  if (href.includes("arc")) return sanitize
  return [plugin, { ...schema, protocols: { ...schema.protocols, href: [...href, "arc"] } }, ...rest]
}

/**
 * Streamdown's default rehype chain (raw → sanitize → harden) drops any href
 * whose protocol isn't in rehype-sanitize's allow-list — so our `arc://work/…`
 * links lose their href, and harden then renders the now-bare `<a>` as a
 * blocked-link indicator (`… [blocked]`). Recompose the chain, reusing
 * Streamdown's own raw + harden untouched and opening exactly the `arc` scheme
 * at the sanitize step, so work links survive while every other scheme stays
 * blocked. Keyed on `"sanitize"` so the raw/harden order is preserved verbatim.
 */
const workRehypePlugins: RehypePlugins = Object.entries(defaultRehypePlugins).map(([key, plugin]) =>
  key === "sanitize" ? allowArcHrefProtocol(plugin) : plugin,
)

const workComponents = (
  onOpenWork: (workId: WorkId) => void,
  onOpenFile: (href: string) => boolean,
) => ({
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
    // `arc://work/` is the only arc affordance we render; sanitize allows the
    // `arc` scheme as a whole, so neutralise any other arc path to inert text
    // rather than emit a live link into an unregistered/unhandled scheme.
    if (href?.startsWith("arc://")) return <span>{children}</span>
    // A file path the assistant linked (`[tracker.js](/Users/…/tracker.js)`):
    // `onOpenFile` opens it in the in-app read-only editor when it resolves inside
    // an open workspace, else hands it to the OS opener — returning true either
    // way so we prevent the anchor's navigation. It returns false only for a
    // non-file href (an http/PR link), which then navigates normally and is routed
    // to the real browser by the main process's `will-navigate` guard.
    return (
      <a
        href={href}
        className="text-accent underline"
        onClick={(event: MouseEvent<HTMLAnchorElement>) => {
          if (href && onOpenFile(href)) event.preventDefault()
        }}
      >
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
 * The recomposed {@link workRehypePlugins} chain whitelists the `arc` href
 * scheme so those links survive Streamdown's sanitize/harden passes.
 *
 * Opening a work item is a shell action, pulled from context rather than
 * threaded through every transcript/detail ancestor. Work ids are always
 * linkified — outside a provider (Storybook) the click is a safe no-op.
 */
/** Stable identity across renders — see the memoization note in WorkMarkdown. */
const WORK_REMARK_PLUGINS = [remarkWorkLinks]

export function WorkMarkdown({
  children,
  streaming = false,
  compact = false,
}: {
  readonly children: string
  readonly streaming?: boolean
  readonly compact?: boolean
}): JSX.Element {
  const { open, openFilePath } = useShellActions()
  // Memoize so Streamdown's per-block memo survives streaming re-renders (a new
  // components object or remark array each delta would re-render every block,
  // Shiki code included). `open`/`openFilePath` are stable shell actions; the
  // remark array has no deps, so it's hoisted to module scope.
  const components = useMemo(
    () => workComponents((workId) => open({ kind: "work", workId }, "right"), openFilePath),
    [open, openFilePath],
  )
  return (
    <Markdown
      compact={compact}
      streaming={streaming}
      components={components}
      remarkPlugins={WORK_REMARK_PLUGINS}
      rehypePlugins={workRehypePlugins}
    >
      {children}
    </Markdown>
  )
}
