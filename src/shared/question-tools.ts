import { Option, Schema } from "effect"
import type { QuestionOption, RequestQuestion } from "./chat-request.js"

/**
 * Effect schemas for every known target-originated "question" tool wire format.
 *
 * These are the raw provider payloads as they arrive on the hook / in an
 * artifact — the source of truth for what each tool actually emits. Projection
 * decodes a payload with the matching schema, then normalizes it into the
 * provider-agnostic {@link RequestQuestion} the renderer consumes. Modelling the
 * wire formats here (rather than field-grubbing in the projection) keeps the
 * shapes documented, validated, and in one place as providers drift.
 *
 * Decoding ignores excess properties, so a richer real payload (extra keys like
 * Claude's `annotations`) still decodes against the subset we model.
 */

// ── Claude: AskUserQuestion ────────────────────────────────────────────────
// Input arrives as `tool_input`, the answer as `tool_response`. Options are
// usually `{label, description}` objects; bare strings are tolerated because
// older transcripts and tests carry that shorthand.

const ClaudeOption = Schema.Union([
  Schema.String,
  Schema.Struct({
    label: Schema.String,
    description: Schema.optional(Schema.String),
  }),
])

export const ClaudeAskUserQuestionInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      question: Schema.String,
      header: Schema.optional(Schema.String),
      multiSelect: Schema.optional(Schema.Boolean),
      options: Schema.optional(Schema.Array(ClaudeOption)),
    }),
  ),
})
export type ClaudeAskUserQuestionInput = typeof ClaudeAskUserQuestionInput.Type

export const ClaudeAskUserQuestionResponse = Schema.Struct({
  /** keyed by the question text → the chosen option label (multi-select joined) */
  answers: Schema.Record(Schema.String, Schema.String),
  annotations: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
})
export type ClaudeAskUserQuestionResponse = typeof ClaudeAskUserQuestionResponse.Type

// ── Cursor: AskQuestion ────────────────────────────────────────────────────
// Questions carry an `id` and `prompt`; options are `{id, label}`. The answer
// comes back as a freeform `result` string, not a structured map.

export const CursorAskQuestionInput = Schema.Struct({
  title: Schema.optional(Schema.String),
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      prompt: Schema.optional(Schema.String),
      question: Schema.optional(Schema.String),
      options: Schema.optional(
        Schema.Array(
          Schema.Union([
            Schema.String,
            Schema.Struct({
              id: Schema.optional(Schema.String),
              label: Schema.optional(Schema.String),
              description: Schema.optional(Schema.String),
            }),
          ]),
        ),
      ),
    }),
  ),
})
export type CursorAskQuestionInput = typeof CursorAskQuestionInput.Type

// ── Codex: request_user_input (artifact only) ──────────────────────────────
// Questions carry `id` + `header` + `question`; the answer nests under the
// question id as `{answers: [label, …]}`, so it is multi-select capable.

export const CodexRequestUserInputInput = Schema.Struct({
  questions: Schema.Array(
    Schema.Struct({
      id: Schema.optional(Schema.String),
      header: Schema.optional(Schema.String),
      question: Schema.optional(Schema.String),
      options: Schema.optional(
        Schema.Array(
          Schema.Struct({
            label: Schema.String,
            description: Schema.optional(Schema.String),
          }),
        ),
      ),
    }),
  ),
})
export type CodexRequestUserInputInput = typeof CodexRequestUserInputInput.Type

export const CodexRequestUserInputResponse = Schema.Struct({
  /** keyed by the question id → the chosen labels */
  answers: Schema.Record(Schema.String, Schema.Struct({ answers: Schema.Array(Schema.String) })),
})
export type CodexRequestUserInputResponse = typeof CodexRequestUserInputResponse.Type

// ── lenient decoders ───────────────────────────────────────────────────────
// Hook payloads are untrusted JSON; `decodeUnknownOption` yields `None` on a
// malformed payload instead of throwing. Call sites unwrap with `Option`.

export const decodeClaudeAskUserQuestionInput = Schema.decodeUnknownOption(ClaudeAskUserQuestionInput)
export const decodeClaudeAskUserQuestionResponse = Schema.decodeUnknownOption(ClaudeAskUserQuestionResponse)
export const decodeCursorAskQuestionInput = Schema.decodeUnknownOption(CursorAskQuestionInput)
export const decodeCodexRequestUserInputInput = Schema.decodeUnknownOption(CodexRequestUserInputInput)
export const decodeCodexRequestUserInputResponse = Schema.decodeUnknownOption(CodexRequestUserInputResponse)

// ── normalization → RequestQuestion[] ──────────────────────────────────────

const claudeOption = (option: string | { label: string; description?: string }): QuestionOption => {
  if (typeof option === "string") return { label: option, value: option }
  return option.description
    ? { label: option.label, value: option.label, description: option.description }
    : { label: option.label, value: option.label }
}

/**
 * Map a decoded Claude AskUserQuestion (input + optional response) into the
 * normalized questions. The answer for each question is looked up by its text
 * in the response's `answers` map, so the renderer can mark the chosen option.
 */
export const normalizeClaudeQuestions = (
  input: ClaudeAskUserQuestionInput,
  response?: ClaudeAskUserQuestionResponse | null,
): ReadonlyArray<RequestQuestion> =>
  input.questions.map((q) => {
    const answer = response?.answers[q.question]
    return {
      prompt: q.question,
      options: (q.options ?? []).map(claudeOption),
      ...(q.header ? { header: q.header } : {}),
      ...(q.multiSelect === undefined ? {} : { multiSelect: q.multiSelect }),
      ...(answer ? { answer } : {}),
    }
  })

const cursorOption = (
  option: string | { id?: string; label?: string; description?: string },
): QuestionOption | null => {
  if (typeof option === "string") return { label: option, value: option }
  const label = option.label ?? option.id
  if (!label) return null
  return option.description
    ? { label, value: option.id ?? label, description: option.description }
    : { label, value: option.id ?? label }
}

/**
 * Cursor reports its answer as freeform result text, one line per answered
 * question: `Question <id>: Selected option(s) <opt>, <opt>` — where `<id>` is
 * the question id and each `<opt>` is an *option id* (not its label). Parse that
 * into a questionId → raw-selection map; {@link normalizeCursorQuestions} maps
 * each selection's option ids back to their labels and lifts it onto the chip.
 */
const CURSOR_ANSWER_LINE = /^Question (.+?): Selected option\(s\) (.+)$/

export const parseCursorAnswerText = (text: string): Record<string, string> => {
  const answers: Record<string, string> = {}
  for (const line of text.split("\n")) {
    const match = line.match(CURSOR_ANSWER_LINE)
    if (!match) continue
    const id = match[1]?.trim()
    const selection = match[2]?.trim()
    if (id && selection) answers[id] = selection
  }
  return answers
}

/** Map a Cursor selection (comma-joined option ids) to human-readable labels,
 * so the renderer shows "Cold" instead of the raw id "cold". An id that matches
 * no option is kept verbatim rather than dropped. */
const cursorSelectionLabels = (
  selection: string,
  options: ReadonlyArray<QuestionOption>,
): string =>
  selection
    .split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0)
    .map((part) => options.find((o) => o.value === part || o.label === part)?.label ?? part)
    .join(", ")

export const normalizeCursorQuestions = (
  input: CursorAskQuestionInput,
  answers?: Record<string, string> | null,
): ReadonlyArray<RequestQuestion> =>
  input.questions
    .map((q): RequestQuestion | null => {
      const prompt = q.prompt ?? q.question ?? q.id
      if (!prompt) return null
      const options = (q.options ?? [])
        .map(cursorOption)
        .filter((v): v is QuestionOption => v !== null)
      const selection = q.id ? answers?.[q.id] : undefined
      const answer = selection ? cursorSelectionLabels(selection, options) : undefined
      return {
        prompt,
        options,
        ...(answer ? { answer } : {}),
      }
    })
    .filter((v): v is RequestQuestion => v !== null)

const codexOption = (option: { label: string; description?: string }): QuestionOption =>
  option.description
    ? { label: option.label, value: option.label, description: option.description }
    : { label: option.label, value: option.label }

export const normalizeCodexQuestions = (
  input: CodexRequestUserInputInput,
  response?: CodexRequestUserInputResponse | null,
): ReadonlyArray<RequestQuestion> =>
  input.questions
    .map((q): RequestQuestion | null => {
      const prompt = q.question ?? q.id ?? q.header
      if (!prompt) return null
      const selected = q.id ? response?.answers[q.id]?.answers : undefined
      return {
        prompt,
        options: (q.options ?? []).map(codexOption),
        ...(q.header ? { header: q.header } : {}),
        ...(selected && selected.length > 0 ? { answer: selected.join(", ") } : {}),
      }
    })
    .filter((v): v is RequestQuestion => v !== null)

// ── one decode entry point ──────────────────────────────────────────────────

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

/** Normalized questions + title for one decoded question tool, plus whether a
 * structured answer map was applied (so a caller can decide not to repeat the
 * answer on the card when it already rides on each chip). */
export interface DecodedQuestion {
  readonly title: string
  readonly questions: ReadonlyArray<RequestQuestion>
  readonly hasStructuredAnswer: boolean
}

/**
 * Decode one target-originated question tool into normalized questions + title,
 * for any provider. This is the single home for the decode → normalize → title
 * sequence that the live-hook path ({@link ../main/hooks/chat-message}) and the
 * artifact path (ChatMessageService) both need: they differ only in where they
 * read the raw input/response bytes and how they derive request *state*, not in
 * how a question tool is interpreted.
 *
 * `rawResponse` is the provider's raw answer payload (Claude `tool_response`,
 * Codex response JSON); Cursor carries its answer as freeform result text and
 * ignores it. Returns null when the tool isn't a known question tool, its input
 * doesn't decode, or it yields no questions.
 */
export const decodeQuestionTool = (
  provider: string,
  toolName: string | null,
  input: Record<string, unknown>,
  rawResponse?: unknown,
): DecodedQuestion | null => {
  if (provider === "cursor" && toolName === "AskQuestion") {
    const decoded = Option.getOrNull(decodeCursorAskQuestionInput(input))
    if (!decoded) return null
    // Cursor's answer is freeform result text, threaded in as `rawResponse`.
    const answers = typeof rawResponse === "string" ? parseCursorAnswerText(rawResponse) : null
    const questions = normalizeCursorQuestions(decoded, answers)
    if (questions.length === 0) return null
    const hasStructuredAnswer = questions.some((q) => q.answer != null)
    return { title: decoded.title ?? "Question", questions, hasStructuredAnswer }
  }
  if (provider === "claude" && toolName === "AskUserQuestion") {
    const decoded = Option.getOrNull(decodeClaudeAskUserQuestionInput(input))
    if (!decoded) return null
    const response =
      rawResponse === undefined ? null : Option.getOrNull(decodeClaudeAskUserQuestionResponse(rawResponse))
    const questions = normalizeClaudeQuestions(decoded, response)
    if (questions.length === 0) return null
    return { title: "Question", questions, hasStructuredAnswer: response !== null }
  }
  if (provider === "codex" && toolName === "request_user_input") {
    const decoded = Option.getOrNull(decodeCodexRequestUserInputInput(input))
    if (!decoded) return null
    const response =
      rawResponse === undefined ? null : Option.getOrNull(decodeCodexRequestUserInputResponse(rawResponse))
    const questions = normalizeCodexQuestions(decoded, response)
    if (questions.length === 0) return null
    return { title: str(input["title"]) ?? "Input requested", questions, hasStructuredAnswer: response !== null }
  }
  return null
}
