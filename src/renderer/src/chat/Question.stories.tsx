import type { ReactNode } from "react"
import type { QuestionRequest as QuestionRequestData } from "../../../shared/chat-request.js"
import { Question } from "./Question.js"

export default {
  title: "Chat / Question",
}

// Mirror the transcript: a question sits flat on the pane background, no card
// chrome. Its own title + state badge mark it (see ROLE_CARD["request"] in
// Message.tsx, which is now empty).
const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div style={{ width: 420, maxWidth: "100%" }}>{children}</div>
)

const noop = () => {}

const pendingChoice: QuestionRequestData = {
  kind: "question",
  state: "pending",
  title: "pick a runtime",
  questions: [
    {
      prompt: "Which package manager should arc use for this workspace?",
      options: [
        { label: "pnpm", value: "pnpm", description: "fast, disk-efficient, monorepo-friendly" },
        { label: "npm", value: "npm", description: "default, broadest compatibility" },
        { label: "yarn", value: "yarn", description: "classic workspaces" },
      ],
    },
  ],
}

const pendingFreeText: QuestionRequestData = {
  kind: "question",
  state: "pending",
  title: "name the branch",
  questions: [
    {
      prompt: "What should the new feature branch be called?",
      options: [],
    },
  ],
}

const multipleQuestions: QuestionRequestData = {
  kind: "question",
  state: "pending",
  title: "configure deploy",
  questions: [
    {
      prompt: "Which environment?",
      options: [
        { label: "staging", value: "staging" },
        { label: "production", value: "production", description: "user-facing" },
      ],
    },
    {
      prompt: "Run database migrations as part of the deploy?",
      options: [
        { label: "yes", value: "yes" },
        { label: "no", value: "no" },
      ],
    },
    {
      prompt: "Anything else the deploy should know about?",
      options: [],
    },
  ],
}

const answered: QuestionRequestData = {
  kind: "question",
  state: "answered",
  title: "pick a runtime",
  questions: [{ ...pendingChoice.questions[0]!, answer: "pnpm" }],
}

const answeredFreeText: QuestionRequestData = {
  kind: "question",
  state: "answered",
  title: "name the branch",
  questions: [{ ...pendingFreeText.questions[0]!, answer: "feat/question-card-polish" }],
}

/** Failure fallback: only an unstructured card-level answer, no per-question lift. */
const answeredPlainTextFallback: QuestionRequestData = {
  kind: "question",
  state: "answered",
  title: "pick a runtime",
  questions: pendingChoice.questions,
  answer: "the target returned a plain-text result with no structured answer",
}

const dismissed: QuestionRequestData = {
  kind: "question",
  state: "dismissed",
  title: "name the branch",
  questions: pendingFreeText.questions,
}

const failed: QuestionRequestData = {
  kind: "question",
  state: "failed",
  title: "configure deploy",
  questions: multipleQuestions.questions,
}

const superseded: QuestionRequestData = {
  kind: "question",
  state: "superseded",
  title: "pick a runtime",
  questions: pendingChoice.questions,
}

const untitled: QuestionRequestData = {
  kind: "question",
  state: "pending",
  questions: [
    {
      prompt: "Continue with the current plan?",
      options: [
        { label: "continue", value: "continue" },
        { label: "revise", value: "revise" },
      ],
    },
  ],
}

const longContent: QuestionRequestData = {
  kind: "question",
  state: "pending",
  title: "resolve-merge-conflict-in-very-long-file-path-that-should-wrap",
  questions: [
    {
      prompt:
        "The file src/renderer/src/components/SomeVeryLongComponentName.tsx has a merge conflict spanning several hunks; how should arc reconcile the diverging changes between the feature branch and main before continuing?",
      options: [
        {
          label: "take-incoming-changes-from-the-feature-branch-wholesale",
          value: "incoming",
          description: "discard local edits in favour of the branch",
        },
        {
          label: "keep-current-changes-on-main",
          value: "current",
        },
      ],
    },
  ],
}

/** Pending question with a fixed set of options (read-only chips). */
export const PendingChoice = () => (
  <Frame>
    <Question request={pendingChoice} />
  </Frame>
)

/** Pending question with no fixed options. */
export const PendingFreeText = () => (
  <Frame>
    <Question request={pendingFreeText} />
  </Frame>
)

/** Pending and live — primary action focuses the target session. */
export const PendingWithFocusTarget = () => (
  <Frame>
    <Question request={pendingChoice} onFocusTarget={noop} />
  </Frame>
)

/** Several questions in one request. */
export const MultipleQuestions = () => (
  <Frame>
    <Question request={multipleQuestions} />
  </Frame>
)

/** Resolved — shows the chosen/typed answer. */
export const Answered = () => (
  <Frame>
    <Question request={answered} />
  </Frame>
)

/** Answer that matches no chip — rendered as a raw answer line. */
export const AnsweredFreeText = () => (
  <Frame>
    <Question request={answeredFreeText} />
  </Frame>
)

/** Unstructured fallback — card-level answer when nothing lifted onto a question. */
export const AnsweredPlainTextFallback = () => (
  <Frame>
    <Question request={answeredPlainTextFallback} />
  </Frame>
)

/** Cleared without an answer. */
export const Dismissed = () => (
  <Frame>
    <Question request={dismissed} />
  </Frame>
)

/** The target failed to collect the answer. */
export const Failed = () => (
  <Frame>
    <Question request={failed} />
  </Frame>
)

/** Replaced by a newer request. */
export const Superseded = () => (
  <Frame>
    <Question request={superseded} />
  </Frame>
)

/** No title — falls back to the "question" label. */
export const Untitled = () => (
  <Frame>
    <Question request={untitled} />
  </Frame>
)

/** Long titles, prompts, and option labels exercise wrapping. */
export const LongContent = () => (
  <Frame>
    <Question request={longContent} />
  </Frame>
)
