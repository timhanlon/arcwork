import type { ReactNode } from "react"
import { MarkdownBody } from "../../ui/MarkdownBody.js"
import { CodeBlock, Collapsible } from "./tool-body.js"

export default {
  title: "Chat / Collapsible",
}

// The transcript row is flat now (see Message.tsx) — no card border or surface.
// Stories sit on the bare pane background so the fade dissolves into the same
// thing it does live: borderless prose into the pane, a bordered CodeBlock into
// its own `bg-input` frame.
const Row = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 460, maxWidth: "100%", background: "var(--bg)", padding: 12 }}>{children}</div>
)

const EXPLORE_PROMPT =
  "# Map the right-panel toggle wiring\n\n" +
  "Find everything related to the right panel and its toggle keybinding in the renderer code. " +
  "Specifically:\n\n" +
  "1. Where the \"right panel\" is defined/rendered (a side panel, inspector, detail panel).\n" +
  "2. The keyboard shortcut / key binding that is supposed to toggle it open/closed.\n" +
  "3. How keybindings are registered/dispatched in this app (central keymap, useKeydown hook, " +
  "Electron accelerator, etc.).\n" +
  "4. Any other panel toggles (e.g. left sidebar toggle) that DO work, to compare the working " +
  "path against the broken right-panel path.\n\n" +
  "Report concrete file paths and line numbers, the relevant code excerpts, and your read on " +
  "where the wiring breaks."

// A command long enough to overflow the 120px cap, so the collapsed state (and
// its fade) actually renders.
const LONG_OUTPUT = Array.from(
  { length: 24 },
  (_, i) => `src/renderer/src/components/file-${i}.tsx:${i + 1}:  const value${i} = compute(${i})`,
).join("\n")

/** Subagent card stack: markdown body inside a frameless Collapsible. The prose
 * is meant to dissolve straight into the pane behind it, so it carries no frame
 * and the mask fades it to nothing. */
export const SubagentMarkdown = () => (
  <Row>
    <Collapsible collapsedHeight={64}>
      <MarkdownBody compact>{EXPLORE_PROMPT}</MarkdownBody>
    </Collapsible>
  </Row>
)

/**
 * Regression fixture: a bordered tool CodeBlock that overflows and collapses.
 * The frame (border + `bg-input`) wraps the masked text rather than carrying the
 * mask, so the box keeps crisp edges — the fade must dissolve only the text, not
 * eat the bottom/side borders. (The old hand-rolled `<pre>` put the border on the
 * masked element and the dissolve ate it.)
 */
export const ToolCodeBlock = () => (
  <Row>
    <CodeBlock text={LONG_OUTPUT} />
  </Row>
)
