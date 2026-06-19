import { memo } from "react"
import type { JSX } from "react"
import type { ChatMessage } from "../../../shared/chat-message.js"
import { parseRecap } from "../../../shared/recap.js"
import { formatActivityTime } from "./activity-event-display.js"
import { MarkdownBody } from "../ui/MarkdownBody.js"
import { Question } from "./Question.js"
import { Collapsible } from "./tool-calls/tool-body.js"
import { ToolCall } from "./tool-calls/ToolCall.js"

// min-w-0: this row is a grid item in the transcript's `ol.grid`; without it the
// item's automatic minimum is its content's min-content width, so a wide code
// block props the whole row (and transcript) open instead of scrolling inside.
const ITEM = "min-w-0"

// Chrome earns its place only where it carries meaning. The bulk of the
// transcript — assistant/subagent/tool/request prose — sits flat on the pane
// background, separated by the `ol`'s row gap and its own role label; a tool
// row's inner `bg-input` code/output panel becomes the single frame instead of a
// box nested in a card. Your own turns get a bare accent stripe (no surface) so
// input is findable without being boxed. A question (request) sits flat too — its
// own title + state badge already mark it, so it doesn't need a card to be found.
// Recaps stay a tinted card: a return-from-away interrupt that should stand out.
const ROLE_CARD: Record<ChatMessage["role"], string> = {
  user: "border-l-2 border-l-accent pl-3",
  assistant: "",
  subagent: "",
  request: "",
  tool: "",
  recap: "bg-[var(--recap-card-bg)] border-l-2 border-l-ok rounded-[var(--radius)] px-3 py-2.5",
  // Programmatic prompt (ScheduleWakeup/`/loop` re-submission, skill injection):
  // faded so it reads as an automated turn, not something typed.
  meta: "opacity-70",
}

const RECAP_LABEL = "font-mono text-[10px] text-ok uppercase tracking-[0.06em] mb-1"

/**
 * Return-from-away recap rendered as a "picking up where you left off" card:
 * the loosely-structured `Goal:` / `Next:` content is split into labelled
 * sections, degrading to the raw text when neither marker is present.
 */
function RecapBody({ body }: { readonly body: string }): JSX.Element {
  const recap = parseRecap(body)
  if (!recap.goal && !recap.next) return <pre className={BODY}>{recap.body}</pre>
  return (
    <div className="flex flex-col gap-2">
      {recap.goal && (
        <div>
          <div className={RECAP_LABEL}>Where you left off</div>
          <pre className={BODY}>{recap.goal}</pre>
        </div>
      )}
      {recap.next && (
        <div>
          <div className={RECAP_LABEL}>Next</div>
          <pre className={BODY}>{recap.next}</pre>
        </div>
      )}
    </div>
  )
}

const META = "flex items-center gap-2 mb-1.5 font-mono text-[10px] text-fg-faint uppercase tracking-[0.06em]"
const BODY = "m-0 font-mono text-xs leading-normal whitespace-pre-wrap break-words text-foreground"

/**
 * Renders a `request`/`tool` message from its single structured `payload`,
 * dispatching on `payload.kind`. There is no legacy `[Title]\n…` text parser or
 * raw-body fallback: a request/tool row with no decodable payload is invalid
 * projection data.
 */
function MessageBody({
  message,
  onFocusSession,
}: {
  readonly message: ChatMessage
  readonly onFocusSession?: (sessionId: string) => void
}): JSX.Element {
  const payload = message.payload
  if (payload?.kind === "question") {
    // We do not synthesize answers by writing into the PTY — provider picker UIs
    // own selection, and injecting keystrokes can silently pick the wrong option.
    // The honest affordance is to focus the live target and let the provider drive.
    const target = message.targetSessionId
    const onFocusTarget =
      message.status === "pending" && target && onFocusSession
        ? () => onFocusSession(target)
        : undefined
    return <Question request={payload} onFocusTarget={onFocusTarget} />
  }
  if (payload?.kind === "tool") return <ToolCall tool={payload} provider={message.provider} />
  if (message.role === "request") {
    return <pre className={BODY}>invalid request projection: missing structured payload</pre>
  }
  if (message.role === "tool") {
    return <pre className={BODY}>invalid tool projection: missing structured payload</pre>
  }
  if (message.role === "recap") return <RecapBody body={message.body} />
  const body = (
    <MarkdownBody compact streaming={message.status === "streaming"}>
      {message.body}
    </MarkdownBody>
  )
  // A subagent's body is the entire prompt it was dispatched with — visible (it
  // tells you what the subagent is doing) but collapsed by default so it doesn't
  // bury the transcript. The fade mask dissolves it into the card behind.
  if (message.role === "subagent") {
    return (
      <Collapsible collapsedHeight={64}>
        {body}
      </Collapsible>
    )
  }
  return body
}

// Memoized: the transcript's stick-to-bottom hook re-renders the whole pane on
// every scroll event (its internal `setIsNearBottom`). Without this, each scroll
// tick re-renders every card — re-running Streamdown/Shiki highlight and the
// Collapsible re-measure — which churns the pane's ResizeObserver and lets the
// pin yank you back to the bottom mid-scroll. Props are referentially stable
// across those internal re-renders (message refs, string `target`, parent
// callbacks), so the default shallow compare skips the work.
export const Message = memo(function Message({
  message,
  target,
  onFocusSession,
}: {
  readonly message: ChatMessage
  /** resolved target label (provider, disambiguated by session) for attribution */
  readonly target?: string
  /** focus the live target session waiting on a pending question */
  readonly onFocusSession?: (sessionId: string) => void
}): JSX.Element {
  const cls = [ITEM, ROLE_CARD[message.role], message.status === "streaming" ? "opacity-[0.92]" : ""]
    .filter(Boolean)
    .join(" ")
  // Live-status pill uses the accent for every role (questions no longer carry
  // the request-orange tint).
  const statusColor = "text-accent"
  return (
    <li className={cls}>
      <div className={META}>
        {/* "assistant" is the default voice and "tool" is named by the tool card
            below it — both add nothing the rest of the row doesn't already say,
            so drop the role word. Other roles keep their label. */}
        {message.role !== "assistant" && message.role !== "tool" && (
          <span className="text-fg-dim">{message.role}</span>
        )}
        {target &&
          (message.role === "user" ? (
            <>
              <span className="text-fg-faint">to</span>
              <span className="text-fg-dim">{target}</span>
            </>
          ) : (
            <span className="text-fg-dim">{target}</span>
          ))}
        {message.role !== "user" && message.model && (
          <span className="text-fg-dim normal-case tracking-normal">{message.model}</span>
        )}
        <time className="ml-auto text-fg-faint" dateTime={message.occurredAt}>
          {formatActivityTime(message.occurredAt)}
        </time>
        {message.status !== "final" && <span className={statusColor}>{message.status}</span>}
      </div>
      <MessageBody message={message} onFocusSession={onFocusSession} />
    </li>
  )
})
