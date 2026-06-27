import type { JSX } from "react"
import { StickToBottom } from "use-stick-to-bottom"
import { WorkMarkdown } from "../work/WorkMarkdown.js"

// Mirrors Message's assistant card, minus the transcript-item concerns: this is
// a standalone block pinned above the composer, not an `<li>` in the `ol.grid`.
// It is render-only and ephemeral — the live hook delta stream for the in-flight
// turn — and is never a persisted chat_messages row. When the turn's text lands
// in the transcript (artifact projection) the host clears it; see UnifiedChatPane.
// Flex column capped at 40vh so a long stream can't shove the composer off
// screen. The cap must live here (not on StickToBottom) because the library's
// Content is `height:100%` — a percentage child needs a definite-height parent,
// which `flex-1 min-h-0` inside this capped column provides.
const CARD =
  "flex flex-col min-h-0 max-h-[40vh] min-w-0 px-3 py-2.5 border border-border border-l-2 border-l-accent bg-elev"
const META = "flex items-center gap-2 mb-1.5 font-mono text-[10px] text-fg-faint uppercase tracking-[0.06em]"

export function StreamingMessage({
  text,
  target,
  model,
}: {
  readonly text: string
  /** resolved target label (provider, disambiguated by session) for attribution */
  readonly target?: string
  /** model producing the stream, when the hook reports it */
  readonly model?: string
}): JSX.Element {
  return (
    <div className={CARD} aria-label="Streaming reply" aria-live="polite">
      <div className={`${META} flex-none`}>
        <span className="text-fg-dim">assistant</span>
        {target && <span className="text-fg-dim">{target}</span>}
        {model && <span className="text-fg-dim normal-case tracking-normal">{model}</span>}
        <span className="flex items-center gap-1 text-accent">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-accent" aria-hidden />
          streaming
        </span>
      </div>
      {/* flex-1 min-h-0: take the remaining capped height and allow shrinking, so
          the library's Content (height:100%) has a definite box to scroll within.
          use-stick-to-bottom keeps the newest tokens in view as content resizes,
          releasing the lock if the reader scrolls up. */}
      <StickToBottom className="min-h-0 flex-1" resize="smooth" initial="instant">
        <StickToBottom.Content>
          <WorkMarkdown compact streaming>
            {text}
          </WorkMarkdown>
        </StickToBottom.Content>
      </StickToBottom>
    </div>
  )
}
