import type { ReactNode } from "react"
import { Markdown } from "./Markdown.js"

export default {
  title: "Components / Markdown",
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
    <Markdown>{KITCHEN_SINK}</Markdown>
  </Surface>
)

/** A code block with a line wider than the surface — it should scroll horizontally, not widen the layout. */
export const WideCodeBlock = () => (
  <Surface>
    <Markdown compact>
      {"```ts\n" +
        "const url = `https://example.com/api/v2/items?include=author,comments,reactions&sort=createdAt&limit=100`\n" +
        "type Row = { id: string; createdAt: string; author: { id: string; displayName: string } }\n" +
        "```"}
    </Markdown>
  </Surface>
)

/** A code block without a language */
export const CodeBlockWithoutLanguage = () => (
  <Surface>
    <Markdown compact>
      {"```\n" +
        "const url = `https://example.com/api/v2/items?include=author,comments,reactions&sort=createdAt&limit=100`\n" +
        "type Row = { id: string; createdAt: string; author: { id: string; displayName: string } }\n" +
        "```"}
    </Markdown>
  </Surface>
)

/** Streaming with a half-finished link/emphasis — `parseIncompleteMarkdown` should keep it readable. */
export const StreamingIncomplete = () => (
  <Surface>
    <Markdown compact streaming>
      {"Working through the plan now. I've **started on the renderer** and am about to "}
    </Markdown>
  </Surface>
)

/** A code block mid-stream, before the closing fence arrives. */
export const StreamingOpenCodeFence = () => (
  <Surface>
    <Markdown compact streaming>
      {"Here's the component:\n\n```tsx\nexport function Markdown({ children })"}
    </Markdown>
  </Surface>
)

/** A ```mermaid fenced block — rendered as a diagram by the @streamdown/mermaid plugin. */
export const Mermaid = () => (
  <Surface>
    <Markdown>
      {"Here's the flow:\n\n" +
        "```mermaid\n" +
        "flowchart TD\n" +
        "  A[Prompt] --> B{Has tool call?}\n" +
        "  B -->|yes| C[Run tool]\n" +
        "  B -->|no| D[Respond]\n" +
        "  C --> D\n" +
        "```"}
    </Markdown>
  </Surface>
)

/** Plain prose with no markdown syntax — should read like ordinary text. */
export const PlainText = () => (
  <Surface>
    <Markdown compact>
      {"Just a plain sentence with no markdown at all, to confirm it degrades cleanly."}
    </Markdown>
  </Surface>
)
