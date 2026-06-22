import type { ReactNode } from "react"
import { MarkdownBody } from "./MarkdownBody.js"

export default {
  title: "Components / MarkdownBody",
}

/** Mirror the prose surface the component lives in — chat/work bodies are width-bounded. */
const Surface = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 520, maxWidth: "100%" }}>{children}</div>
)

const KITCHEN_SINK = `# Heading one

A paragraph with **bold**, *italic*, \`inline code\`, and a [link](https://example.com)
that wraps to show line height and prose color.

## Heading two

- First bullet
- Second bullet with a nested list
  - Nested item
  - Another nested item
- Third bullet

1. Ordered one
2. Ordered two

> A blockquote, for the dim left-border treatment.

### Heading three

\`\`\`ts
function greet(name: string): string {
  return \`hello, \${name}\`
}
\`\`\`

| Column A | Column B |
| -------- | -------- |
| one      | two      |
| three    | four     |

---

Trailing paragraph after a horizontal rule.`

/** Every element type at once — the visual reference for Streamdown's default rendering. */
export const KitchenSink = () => (
  <Surface>
    <MarkdownBody>{KITCHEN_SINK}</MarkdownBody>
  </Surface>
)

/**
 * The chat path: work ids are linkified via a custom remark plugin (clicking
 * dispatches `open({kind:"work"}, "right")` from shell context — a no-op here with no
 * provider mounted). GFM features (table, ~~strikethrough~~, task list) must
 * survive that plugin swap — this is the case that regressed when the plugin
 * override dropped remark-gfm.
 */
export const TableWithWorkLinks = () => (
  <Surface>
    <MarkdownBody compact>
      {"Routing to `work_abc123` — here's the breakdown:\n\n" +
        "| Tool   | Usage location        | Recorded |\n" +
        "| ------ | --------------------- | -------- |\n" +
        "| Claude | per-message `usage`   | yes      |\n" +
        "| Codex  | rolled into turn event| yes      |\n" +
        "| Cursor | ~~not recorded~~      | no       |\n\n" +
        "- [x] tables\n" +
        "- [ ] charts"}
    </MarkdownBody>
  </Surface>
)

/** The full-prose form used for work descriptions. */
export const WorkBody = () => (
  <Surface>
    <MarkdownBody>
      {"## Goal\n\nExtract token-usage data in `arc-ingest`.\n\n" +
        "Each tool stores usage differently:\n\n" +
        "- **Claude** — per-message `usage` block\n" +
        "- **Codex** — rolled into the turn event\n" +
        "- **Cursor** — not recorded\n\n" +
        "Next: pick a storage shape so we can wire up extraction."}
    </MarkdownBody>
  </Surface>
)

/** The compact form used for chat messages — smaller type, tighter leading. */
export const Compact = () => (
  <Surface>
    <MarkdownBody compact>
      {"Done — committed and pushed. Here's what changed:\n\n" +
        "1. Replaced `<pre>` with `MarkdownBody`\n" +
        "2. Let Streamdown own the rendering\n\n" +
        "```sh\ngit commit -m \"feat: render markdown\"\n```"}
    </MarkdownBody>
  </Surface>
)

/** A code block with a line wider than the surface — it should scroll horizontally, not widen the layout. */
export const WideCodeBlock = () => (
  <Surface>
    <MarkdownBody compact>
      {"```ts\n" +
        "const url = `https://example.com/api/v2/items?include=author,comments,reactions&sort=createdAt&limit=100`\n" +
        "type Row = { id: string; createdAt: string; author: { id: string; displayName: string } }\n" +
        "```"}
    </MarkdownBody>
  </Surface>
)

/** A code block without a language */
export const CodeBlockWithoutLanguage = () => (
  <Surface>
    <MarkdownBody compact>
      {"```\n" +
        "const url = `https://example.com/api/v2/items?include=author,comments,reactions&sort=createdAt&limit=100`\n" +
        "type Row = { id: string; createdAt: string; author: { id: string; displayName: string } }\n" +
        "```"}
    </MarkdownBody>
  </Surface>
)

/** Streaming with a half-finished link/emphasis — `parseIncompleteMarkdown` should keep it readable. */
export const StreamingIncomplete = () => (
  <Surface>
    <MarkdownBody compact streaming>
      {"Working through the plan now. I've **started on the renderer** and am about to "}
    </MarkdownBody>
  </Surface>
)

/** A code block mid-stream, before the closing fence arrives. */
export const StreamingOpenCodeFence = () => (
  <Surface>
    <MarkdownBody compact streaming>
      {"Here's the component:\n\n```tsx\nexport function MarkdownBody({ children })"}
    </MarkdownBody>
  </Surface>
)

/** A ```mermaid fenced block — rendered as a diagram by the @streamdown/mermaid plugin. */
export const Mermaid = () => (
  <Surface>
    <MarkdownBody>
      {"Here's the flow:\n\n" +
        "```mermaid\n" +
        "flowchart TD\n" +
        "  A[Prompt] --> B{Has tool call?}\n" +
        "  B -->|yes| C[Run tool]\n" +
        "  B -->|no| D[Respond]\n" +
        "  C --> D\n" +
        "```"}
    </MarkdownBody>
  </Surface>
)

/** Plain prose with no markdown syntax — should read like ordinary text. */
export const PlainText = () => (
  <Surface>
    <MarkdownBody compact>
      {"Just a plain sentence with no markdown at all, to confirm it degrades cleanly."}
    </MarkdownBody>
  </Surface>
)
