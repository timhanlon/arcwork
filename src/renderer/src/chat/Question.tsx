import { CheckIcon } from "@phosphor-icons/react"
import type { JSX } from "react"
import type {
  QuestionRequest as QuestionRequestData,
  RequestQuestion,
} from "../../../shared/chat-request.js"
import { Badge } from "../ui/Badge.js"
import { Button } from "../ui/Button.js"

const STATE_LABEL: Record<QuestionRequestData["state"], string> = {
  pending: "awaiting answer",
  answered: "answered",
  dismissed: "dismissed",
  failed: "failed",
  superseded: "superseded",
}

const CARD = "grid gap-2.5 min-w-0"
const HEAD = "flex items-center justify-between gap-2"
const TITLE = "font-mono text-xs font-semibold text-foreground"
const QUESTION = "grid gap-[7px] min-w-0"
const PROMPT = "text-[13px] leading-[1.45] text-foreground [overflow-wrap:anywhere]"
const OPTION =
  "max-w-full px-[7px] py-1 border border-border bg-input text-foreground font-mono text-[11px] leading-[1.35] [overflow-wrap:anywhere]"
const OPTION_CHOSEN =
  "inline-flex items-center gap-1 max-w-full px-[7px] py-1 border border-border-strong bg-input text-foreground font-mono text-[11px] font-semibold leading-[1.35] [overflow-wrap:anywhere]"
// Keep the focus action a hair stronger than the chips, but on the neutral
// `solid` button skin (border-strong + accent hover) — no request-orange tint.
const FOCUS_TARGET = "font-semibold"
const HINT = "font-mono text-[11px] text-fg-faint"

export interface QuestionProps {
  readonly request: QuestionRequestData
  /**
   * Focus the live target session waiting on this question. Present only when
   * the question is pending and its target is live. We deliberately do not offer
   * inline answer buttons: arc can observe and display a question, but provider
   * picker UIs own the actual selection — synthesizing PTY keystrokes to answer
   * is brittle and can silently choose the wrong option. The honest affordance
   * is to take the user to the target, where the provider drives the interaction.
   */
  readonly onFocusTarget?: () => void
}

/**
 * Target-originated question. arc-specific (no AI Elements analog).
 * Options always render as read-only chips: this card describes the question,
 * it does not answer it. While pending and live, the primary action focuses the
 * target so the provider's own picker UI can take the answer.
 */
/**
 * Match an answer back to one of its question's options by value or label, so
 * the chosen chip can be highlighted. The answer rides on the question it
 * answers ({@link RequestQuestion.answer}), lifted from the provider's answers
 * map by projection. Multi-select answers are joined with ", " — split so each
 * selected chip lights up (an exact whole-string match is tried first, so a
 * single-select label that itself contains a comma still matches).
 */
const isChosen = (question: RequestQuestion, option: { value: string; label: string }): boolean => {
  const answer = question.answer?.trim()
  if (answer == null || answer.length === 0) return false
  if (answer === option.value || answer === option.label) return true
  return answer
    .split(",")
    .map((part) => part.trim())
    .some((part) => part === option.value || part === option.label)
}

export function Question({ request, onFocusTarget }: QuestionProps): JSX.Element {
  // The chosen answer rides on each question. `request.answer` is a card-level
  // fallback for the unstructured case (e.g. a failed tool returning only plain
  // text) where no per-question answer was lifted.
  const anyQuestionAnswered = request.questions.some((q) => (q.answer?.trim() ?? "").length > 0)
  return (
    <div className={CARD}>
      <div className={HEAD}>
        <span className={TITLE}>{request.title ?? "question"}</span>
        {/* "answered" is noise — the chosen chip / answer line already says so. */}
        {request.state !== "answered" && <Badge tone="neutral">{STATE_LABEL[request.state]}</Badge>}
      </div>
      {request.questions.map((question) => {
        const answer = question.answer?.trim()
        const answerShownAsChip =
          answer != null && question.options.some((option) => isChosen(question, option))
        return (
          <div key={question.prompt} className={QUESTION}>
            <div className={PROMPT}>{question.prompt}</div>
            {question.options.length > 0 && (
              <div className="flex flex-wrap gap-1.5">
                {question.options.map((option) => {
                  const chosen = isChosen(question, option)
                  return (
                    <span
                      key={option.value}
                      className={chosen ? OPTION_CHOSEN : OPTION}
                      title={option.description}
                    >
                      {chosen && <CheckIcon size={11} weight="bold" className="shrink-0" />}
                      {option.label}
                    </span>
                  )
                })}
              </div>
            )}
            {question.options.length === 0 && !answer && <div className={HINT}>Answer in target</div>}
            {/* Free-text answer (no options, or matched no chip): show it in full. */}
            {answer && !answerShownAsChip && (
              <div className="font-mono text-[11px] font-semibold leading-[1.35] text-foreground [overflow-wrap:anywhere]">
                {answer}
              </div>
            )}
          </div>
        )
      })}
      {request.answer && !anyQuestionAnswered && (
        <pre className="mt-0.5 pt-2 border-t border-t-border text-fg-dim font-mono text-[11px] leading-[1.45] whitespace-pre-wrap break-words">
          {request.answer}
        </pre>
      )}
      {onFocusTarget && (
        <div className="flex items-baseline gap-2 flex-wrap">
          <Button variant="solid" className={FOCUS_TARGET} onClick={onFocusTarget}>
            Focus target
          </Button>
          <span className={HINT}>answer in the target session</span>
        </div>
      )}
    </div>
  )
}
