import { useState } from "react"
import { WorkBodyEditor } from "./WorkBodyEditor.js"

export default {
  title: "Work / WorkBodyEditor",
}

const SEED = `# Heading

A paragraph with **bold**, *italic*, and \`inline code\`.

- a bullet
- another with a [link](https://example.com)

1. first
2. second

> a blockquote

\`\`\`ts
const x = 1
\`\`\`
`

/** The ProseKit body editor next to a live read-out of the markdown it
 * serialises on every change — the round-trip we care about for the spike. */
function Harness({ initial }: { initial: string }) {
  const [markdown, setMarkdown] = useState(initial)
  return (
    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, width: 760, padding: 16 }}>
      <div>
        <p style={{ marginBottom: 8, font: "11px ui-monospace, monospace", color: "var(--fg-faint)" }}>editor</p>
        <WorkBodyEditor defaultMarkdown={initial} onChange={setMarkdown} />
      </div>
      <div>
        <p style={{ marginBottom: 8, font: "11px ui-monospace, monospace", color: "var(--fg-faint)" }}>
          serialised markdown
        </p>
        <pre
          style={{
            margin: 0,
            whiteSpace: "pre-wrap",
            font: "11px ui-monospace, monospace",
            color: "var(--foreground)",
            background: "var(--input)",
            border: "1px solid var(--border)",
            borderRadius: "var(--radius)",
            padding: 8,
            minHeight: "12rem",
          }}
        >
          {markdown}
        </pre>
      </div>
    </div>
  )
}

export const Rich = () => <Harness initial={SEED} />
export const Empty = () => <Harness initial="" />
