import { Schema } from "effect"

/**
 * Structured target-originated input requests, carried on a `request`-role
 * {@link ChatMessage}. Replaces the legacy `[Title]\n…` text body that the
 * renderer used to re-parse: projection now emits structure, the renderer
 * dispatches on `kind`.
 *
 * Only the question family is a durable request payload. A tool that needs
 * approval is recorded as its `tool`-role row; the live "awaiting approval"
 * moment is the in-memory sidebar flag ({@link PendingRequest}), not an inline
 * card. See docs/proposals/2026-06-05-electron-ui-refactor.md.
 */

/** Answer/dismiss lifecycle for a question request. */
export const QuestionState = Schema.Literals([
  "pending",
  "answered",
  "dismissed",
  "failed",
  "superseded",
])
export type QuestionState = typeof QuestionState.Type

export const QuestionOption = Schema.Struct({
  label: Schema.String,
  /** value submitted to the target when chosen (often equals label) */
  value: Schema.String,
  description: Schema.optional(Schema.String),
})
export type QuestionOption = typeof QuestionOption.Type

export const RequestQuestion = Schema.Struct({
  prompt: Schema.String,
  /** short category tag for the question (Claude/Codex `header`, e.g. "Scope") */
  header: Schema.optional(Schema.String),
  options: Schema.Array(QuestionOption),
  /** the provider accepts more than one selected option */
  multiSelect: Schema.optional(Schema.Boolean),
  /**
   * the chosen option label(s) for this specific question, lifted from the
   * provider's answers map. Multi-select answers are joined with ", ". The
   * renderer matches this back to {@link QuestionOption} labels to mark the
   * selection; free-text answers (no matching option) render as a line.
   */
  answer: Schema.optional(Schema.String),
})
export type RequestQuestion = typeof RequestQuestion.Type

/** One or more questions awaiting an answer — arc-specific (no AI Elements analog). */
export const QuestionRequest = Schema.Struct({
  kind: Schema.Literal("question"),
  state: QuestionState,
  title: Schema.optional(Schema.String),
  questions: Schema.Array(RequestQuestion),
  /** chosen/typed answer, shown after the request is answered */
  answer: Schema.optional(Schema.String),
})
export type QuestionRequest = typeof QuestionRequest.Type

/**
 * The structured payload of a `request`-role message. Currently a single family
 * (question); kept as a named alias so the renderer/projection keep dispatching
 * on `kind` and a second family can rejoin as a union without churn.
 */
export const ChatRequest = QuestionRequest
export type ChatRequest = typeof ChatRequest.Type

/**
 * A target-originated request still awaiting the user, projected across all
 * chats. Broadcast as a live list so the sidebar can flag which sessions need an
 * answer without loading every chat's transcript. Clicking the flagged session
 * focuses its target, where the provider's own picker UI takes the answer.
 */
export const PendingRequest = Schema.Struct({
  chatId: Schema.String,
  targetSessionId: Schema.String,
  kind: Schema.Literals(["permission", "question"]),
})
export type PendingRequest = typeof PendingRequest.Type
