import type { ReactNode } from "react"
import { StreamingMessage } from "./StreamingMessage.js"

export default {
  title: "Chat / StreamingMessage",
}

// Approximates the composer footer: the streaming block is pinned just above it.
const AboveComposer = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 520, maxWidth: "100%", display: "grid", gap: 8 }}>
    {children}
    <div
      style={{
        minHeight: 72,
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
        background: "var(--input)",
        padding: "10px 12px",
        font: "12px monospace",
        color: "var(--fg-faint)",
      }}
    >
      Message target…
    </div>
  </div>
)

export const MidStream = () => (
  <AboveComposer>
    <StreamingMessage
      target="claude"
      model="claude-opus-4-8"
      text={"Let me look at how the transcript watcher fires during a live turn. The two projection paths stamp"}
    />
  </AboveComposer>
)

export const WithMarkdown = () => (
  <AboveComposer>
    <StreamingMessage
      target="claude"
      text={"I'll fix this in two steps:\n\n1. Make artifacts the source of truth\n2. Add the ephemeral `StreamingMessage`\n\nStarting with"}
    />
  </AboveComposer>
)

export const ShortToken = () => (
  <AboveComposer>
    <StreamingMessage target="claude" text="Reading" />
  </AboveComposer>
)
