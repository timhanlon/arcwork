import { useState } from "react"
import { WorkDetailEditor } from "./WorkDetailEditor.js"

export default {
  title: "Work / WorkDetailEditor",
}

const LONG_BODY = `A body long enough to scroll, so the action bar's stickiness is
visible.

## Section

- one
- two
- three

More prose to push the actions below the fold. Lorem ipsum dolor sit amet,
consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore.

Another paragraph. Ut enim ad minim veniam, quis nostrud exercitation ullamco
laboris nisi ut aliquip ex ea commodo consequat.

\`\`\`ts
const x = 1
\`\`\`

Final paragraph so the footer has content to scroll under.`

/** The editor owns its own scroll region + pinned action bar, so the harness
 * just gives it a fixed-height flex column to fill (the pane's role). The bar
 * must stay pinned to the bottom for *both* a long body (scrolls) and a short
 * one (the case that exposed the non-sticky bug). */
function Harness({ initialBody }: { initialBody: string }) {
  const [title, setTitle] = useState("Pin the editor action bar")
  const [body, setBody] = useState(initialBody)
  const [labels, setLabels] = useState("ui, editor")
  const [log, setLog] = useState<string>("")
  return (
    <div style={{ width: 460 }}>
      <div
        style={{ height: 320, display: "flex", flexDirection: "column", border: "1px solid var(--border)" }}
      >
        <WorkDetailEditor
          title={title}
          body={body}
          labels={labels}
          onTitle={setTitle}
          onBody={setBody}
          onLabels={setLabels}
          onCancel={() => setLog("cancel")}
          onSave={(edits) => setLog(`save: ${JSON.stringify(edits)}`)}
        />
      </div>
      <p style={{ marginTop: 8, font: "11px ui-monospace, monospace", color: "var(--fg-faint)" }}>
        last action: {log || "(none — try Esc / ⌘S)"}
      </p>
    </div>
  )
}

export const LongBody = () => <Harness initialBody={LONG_BODY} />
export const ShortBody = () => <Harness initialBody="Just one line." />
