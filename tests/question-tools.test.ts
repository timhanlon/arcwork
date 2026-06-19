import { Option } from "effect"
import { describe, expect, it } from "vitest"
import {
  decodeClaudeAskUserQuestionInput,
  decodeClaudeAskUserQuestionResponse,
  decodeCodexRequestUserInputInput,
  decodeCodexRequestUserInputResponse,
  decodeCursorAskQuestionInput,
  decodeQuestionTool,
  normalizeClaudeQuestions,
  normalizeCodexQuestions,
  normalizeCursorQuestions,
} from "../src/shared/question-tools.js"

describe("question tool schemas", () => {
  it("decodes and normalizes Claude AskUserQuestion", () => {
    const input = Option.getOrThrow(decodeClaudeAskUserQuestionInput({
      questions: [
        {
          header: "Scope",
          question: "Where should I make the change?",
          multiSelect: false,
          options: [{ label: "App", description: "Application code" }, "Tests"],
        },
      ],
      extra: "ignored",
    }))
    const response = Option.getOrThrow(decodeClaudeAskUserQuestionResponse({
      answers: { "Where should I make the change?": "Tests" },
      annotations: { ok: true },
    }))

    expect(normalizeClaudeQuestions(input, response)).toEqual([
      {
        header: "Scope",
        prompt: "Where should I make the change?",
        multiSelect: false,
        options: [
          { label: "App", value: "App", description: "Application code" },
          { label: "Tests", value: "Tests" },
        ],
        answer: "Tests",
      },
    ])
  })

  it("decodes and normalizes Cursor AskQuestion", () => {
    const input = Option.getOrThrow(decodeCursorAskQuestionInput({
      title: "Temperature check",
      questions: [
        {
          id: "temperature",
          prompt: "Is it hot or cold?",
          options: [{ id: "hot", label: "Hot" }, { id: "cold", label: "Cold" }],
        },
      ],
    }))

    expect(normalizeCursorQuestions(input)).toEqual([
      {
        prompt: "Is it hot or cold?",
        options: [
          { label: "Hot", value: "hot" },
          { label: "Cold", value: "cold" },
        ],
      },
    ])

    // Cursor's freeform result text carries the chosen option id keyed by the
    // question id; the answer is mapped back to the option label on the chip.
    expect(normalizeCursorQuestions(input, { temperature: "cold" })[0]?.answer).toBe("Cold")
  })

  it("parses Cursor result text and lifts the labelled answer via decodeQuestionTool", () => {
    const input = {
      title: "Temperature check",
      questions: [
        {
          id: "temperature",
          prompt: "Is it hot or cold?",
          options: [{ id: "hot", label: "Hot" }, { id: "cold", label: "Cold" }],
        },
      ],
    }
    const decoded = decodeQuestionTool(
      "cursor",
      "AskQuestion",
      input,
      "User questions responses:\nQuestion temperature: Selected option(s) cold",
    )
    expect(decoded?.hasStructuredAnswer).toBe(true)
    expect(decoded?.questions[0]?.answer).toBe("Cold")

    // No result text → no structured answer, chip stays unanswered.
    const pending = decodeQuestionTool("cursor", "AskQuestion", input)
    expect(pending?.hasStructuredAnswer).toBe(false)
    expect(pending?.questions[0]?.answer).toBeUndefined()
  })

  it("decodes and normalizes Codex request_user_input", () => {
    const input = Option.getOrThrow(decodeCodexRequestUserInputInput({
      questions: [
        {
          id: "favorite_color",
          header: "Color",
          question: "What is your favorite color?",
          options: [
            { label: "Blue (Recommended)", description: "Select this if blue is your favorite color." },
            { label: "Green" },
          ],
        },
      ],
    }))
    const response = Option.getOrThrow(decodeCodexRequestUserInputResponse({
      answers: { favorite_color: { answers: ["Blue (Recommended)"] } },
    }))

    expect(normalizeCodexQuestions(input, response)).toEqual([
      {
        header: "Color",
        prompt: "What is your favorite color?",
        options: [
          {
            label: "Blue (Recommended)",
            value: "Blue (Recommended)",
            description: "Select this if blue is your favorite color.",
          },
          { label: "Green", value: "Green" },
        ],
        answer: "Blue (Recommended)",
      },
    ])
  })
})

describe("decodeQuestionTool (shared decode entry point)", () => {
  it("gates on provider + tool name", () => {
    const input = { questions: [{ prompt: "Pick", options: [{ id: "a", label: "A" }] }] }
    // Right tool, wrong provider pairing → null.
    expect(decodeQuestionTool("claude", "AskQuestion", input)).toBeNull()
    expect(decodeQuestionTool("cursor", "Read", input)).toBeNull()
    // Right pairing → decoded.
    expect(decodeQuestionTool("cursor", "AskQuestion", input)?.title).toBe("Question")
  })

  it("reports hasStructuredAnswer and lifts the answer onto its question", () => {
    const input = { questions: [{ question: "Cats or dogs?", options: ["Cats", "Dogs"] }] }
    const pending = decodeQuestionTool("claude", "AskUserQuestion", input)
    expect(pending?.hasStructuredAnswer).toBe(false)
    expect(pending?.questions[0]?.answer).toBeUndefined()

    const answered = decodeQuestionTool("claude", "AskUserQuestion", input, {
      answers: { "Cats or dogs?": "Cats" },
    })
    expect(answered?.hasStructuredAnswer).toBe(true)
    expect(answered?.questions[0]?.answer).toBe("Cats")
  })

  it("titles Codex request_user_input distinctly and returns null for empty questions", () => {
    expect(
      decodeQuestionTool("codex", "request_user_input", {
        questions: [{ id: "q", question: "Which?", options: [{ label: "X" }] }],
      })?.title,
    ).toBe("Input requested")
    expect(decodeQuestionTool("codex", "request_user_input", { questions: [] })).toBeNull()
  })
})
