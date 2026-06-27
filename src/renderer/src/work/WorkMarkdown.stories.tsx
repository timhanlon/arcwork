import type { ReactNode } from "react"
import { WorkMarkdown } from "./WorkMarkdown.js"

export default {
  title: "Work / WorkMarkdown",
}

/** Mirror the prose surface the component lives in — chat/work bodies are width-bounded. */
const Surface = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 520, maxWidth: "100%" }}>{children}</div>
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
    <WorkMarkdown compact>
      {"Routing to `work_abc123` — here's the breakdown:\n\n" +
        "| Tool   | Usage location        | Recorded |\n" +
        "| ------ | --------------------- | -------- |\n" +
        "| Claude | per-message `usage`   | yes      |\n" +
        "| Codex  | rolled into turn event| yes      |\n" +
        "| Cursor | ~~not recorded~~      | no       |\n\n" +
        "- [x] tables\n" +
        "- [ ] charts"}
    </WorkMarkdown>
  </Surface>
)

/** The full-prose form used for work descriptions. */
export const WorkBody = () => (
  <Surface>
    <WorkMarkdown>
      {"## Goal\n\nExtract token-usage data in `arc-ingest`.\n\n" +
        "Each tool stores usage differently:\n\n" +
        "- **Claude** — per-message `usage` block\n" +
        "- **Codex** — rolled into the turn event\n" +
        "- **Cursor** — not recorded\n\n" +
        "Next: pick a storage shape so we can wire up extraction."}
    </WorkMarkdown>
  </Surface>
)

/** The compact form used for chat messages — smaller type, tighter leading. */
export const Compact = () => (
  <Surface>
    <WorkMarkdown compact>
      {"Done — committed and pushed. Here's what changed:\n\n" +
        "1. Replaced `<pre>` with `WorkMarkdown`\n" +
        "2. Let Streamdown own the rendering\n\n" +
        "```sh\ngit commit -m \"feat: render markdown\"\n```"}
    </WorkMarkdown>
  </Surface>
)
