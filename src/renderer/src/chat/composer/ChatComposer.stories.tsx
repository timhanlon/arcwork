import { useState } from "react"
import { ChatComposer } from "./ChatComposer.js"
import type { ReferenceCandidate } from "./references.js"

export default {
  title: "Chat / ChatComposer",
}

/** A spread of all three kinds so the `@` picker shows work, files, and sessions
 * together — the unified-picker bet in one view. */
const CANDIDATES: ReadonlyArray<ReferenceCandidate> = [
  { kind: "work", key: "work_a", label: "Fix the transcript streaming race", detail: "active · work_01j2a", insertText: "work_01j2a3b4c5" },
  { kind: "work", key: "work_b", label: "Add priority to work items", detail: "done · work_01j2b", insertText: "work_01j2b6d7e8" },
  { kind: "file", key: "f1", label: "ChatComposer.tsx", detail: "src/renderer/src/composer", insertText: "src/renderer/src/composer/ChatComposer.tsx" },
  { kind: "file", key: "f2", label: "UnifiedChatPane.tsx", detail: "src/renderer/src", insertText: "src/renderer/src/UnifiedChatPane.tsx" },
  { kind: "file", key: "f3", label: "keybindings.ts", detail: "src/renderer/src/shell", insertText: "src/renderer/src/shell/keybindings.ts" },
  { kind: "file", key: "f4", label: "references.ts", detail: "src/renderer/src/composer", insertText: "src/renderer/src/composer/references.ts" },
  { kind: "session", key: "s1", label: "claude", detail: "target_01j9z", insertText: "target_01j9z8y7x6" },
  { kind: "session", key: "s2", label: "codex", detail: "target_01j9y", insertText: "target_01j9y5w4v3" },
]

/** The composer is bottom-anchored in the real pane; pad the top so the
 * caret-anchored popup (which opens upward) has room to render. */
function Harness({ truncated = false }: { truncated?: boolean }) {
  const [value, setValue] = useState("")
  const [target, setTarget] = useState<string | undefined>(undefined)
  return (
    <div style={{ width: 460, paddingTop: 320 }}>
      <p style={{ marginBottom: 8, font: "11px ui-monospace, monospace", color: "var(--fg-faint)" }}>
        to: {target ?? "(auto)"}
      </p>
      <ChatComposer
        value={value}
        onChange={setValue}
        onSend={() => console.log("send:", value, "→", target)}
        onSelectTarget={setTarget}
        candidates={CANDIDATES}
        filesTruncated={truncated}
      />
      <p style={{ marginTop: 8, font: "11px ui-monospace, monospace", color: "var(--fg-faint)" }}>
        draft: {JSON.stringify(value)}
      </p>
    </div>
  )
}

/** Type `@` to open the unified picker; arrow keys navigate, Enter inserts. */
export const Default = () => <Harness />

/** Picker footer when the workspace file list was capped main-side. */
export const TruncatedFiles = () => <Harness truncated />
