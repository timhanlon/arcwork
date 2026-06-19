import { describe, expect, it } from "vitest"
import { artifactQuestionBody, artifactQuestionRequest, artifactToolCall } from "../src/main/services/chat-message/artifact-projection.js"
import type { ToolCallRow } from "../src/main/ingest/db/schema.js"

const tool = (row: Partial<ToolCallRow>): ToolCallRow => ({
  id: "tool_01",
  sessionId: "session_01",
  messageId: null,
  provider: "cursor",
  nativeToolId: "native_tool_01",
  name: "AskQuestion",
  kind: "generic",
  inputJson: null,
  outputText: null,
  rawJson: null,
  sequence: 0,
  ordinal: 0,
  ...row,
})

describe("artifact question display projection", () => {
  it("formats Cursor AskQuestion rows", () => {
    const body = artifactQuestionBody(tool({
      provider: "cursor",
      name: "AskQuestion",
      inputJson: JSON.stringify({
        title: "Temperature check",
        questions: [
          {
            id: "temperature",
            prompt: "Is it hot or cold?",
            options: [{ id: "hot", label: "Hot" }, { id: "cold", label: "Cold" }],
          },
        ],
      }),
      outputText: "User questions responses:\nQuestion temperature: Selected option(s) cold",
    }))

    expect(body).toContain("[Temperature check]")
    expect(body).toContain("Is it hot or cold?")
    expect(body).toContain("Options:\n- Hot\n- Cold")
    // The chosen option id ("cold") is mapped to its label and lifted onto the
    // question, not echoed verbatim as the raw result sentence.
    expect(body).toContain("Answer: Cold")
    expect(body).not.toContain("Selected option(s)")
  })

  it("formats Codex request_user_input rows", () => {
    const body = artifactQuestionBody(tool({
      provider: "codex",
      name: "request_user_input",
      inputJson: JSON.stringify({
        questions: [
          {
            header: "Color",
            id: "favorite_color",
            question: "What is your favorite color?",
            options: [
              { label: "Blue (Recommended)", description: "Select this if blue is your favorite color." },
              { label: "Green", description: "Select this if green is your favorite color." },
            ],
          },
        ],
      }),
      outputText: JSON.stringify({ answers: { favorite_color: { answers: ["Blue (Recommended)"] } } }),
    }))

    expect(body).toContain("[Input requested]")
    expect(body).toContain("What is your favorite color?")
    expect(body).toContain("Blue (Recommended) — Select this if blue is your favorite color.")
    expect(body).toContain("\"favorite_color\"")
  })

  it("formats Claude AskUserQuestion rows", () => {
    const body = artifactQuestionBody(tool({
      provider: "claude",
      name: "AskUserQuestion",
      inputJson: JSON.stringify({
        questions: [
          {
            question: "Do you like cats or dogs?",
            header: "Pets",
            options: [
              { label: "Cats", description: "You're a cat person." },
              { label: "Dogs", description: "You're a dog person." },
            ],
          },
        ],
      }),
      outputText: 'Your questions have been answered: "Do you like cats or dogs?"="Cats".',
    }))

    expect(body).toContain("[Question]")
    expect(body).toContain("Do you like cats or dogs?")
    expect(body).toContain("Cats — You're a cat person.")
    expect(body).toContain('="Cats"')
  })

  it("lifts the chosen Claude answer onto its question from the result sidecar", () => {
    // The wire reality: `outputText` is the human sentence, while the chosen
    // option map rides in the structured `toolUseResult` sidecar (`rawJson`).
    const request = artifactQuestionRequest(tool({
      provider: "claude",
      name: "AskUserQuestion",
      inputJson: JSON.stringify({
        questions: [
          {
            question: "Do you prefer cats or dogs?",
            header: "Pets",
            multiSelect: false,
            options: [
              { label: "Cats", description: "Independent." },
              { label: "Dogs", description: "Loyal." },
            ],
          },
        ],
      }),
      outputText: 'Your questions have been answered: "Do you prefer cats or dogs?"="Cats".',
      rawJson: JSON.stringify({
        questions: [{ question: "Do you prefer cats or dogs?" }],
        answers: { "Do you prefer cats or dogs?": "Cats" },
        annotations: {},
      }),
    }))

    expect(request?.state).toBe("answered")
    // The chosen label lands on the question so the renderer marks the chip…
    expect(request?.questions[0]?.answer).toBe("Cats")
    // …and the plain sentence is dropped to avoid showing the answer twice.
    expect(request?.answer).toBeUndefined()
  })

  it("builds a structured question request, answered when output is present", () => {
    const answered = artifactQuestionRequest(tool({
      provider: "cursor",
      name: "AskQuestion",
      inputJson: JSON.stringify({
        title: "Temperature check",
        questions: [
          {
            id: "temperature",
            prompt: "Is it hot or cold?",
            options: [{ id: "hot", label: "Hot" }, { id: "cold", label: "Cold" }],
          },
        ],
      }),
      outputText: "Question temperature: Selected option(s) cold",
    }))
    expect(answered?.kind).toBe("question")
    expect(answered?.state).toBe("answered")
    expect(answered?.title).toBe("Temperature check")
    expect(answered?.questions[0]?.options).toEqual([
      { label: "Hot", value: "hot" },
      { label: "Cold", value: "cold" },
    ])
    // The chosen option rides on the question (id → label), so the chip lights
    // up; the raw result sentence is no longer kept as a card-level fallback.
    expect(answered?.questions[0]?.answer).toBe("Cold")
    expect(answered?.answer).toBeUndefined()

    const pending = artifactQuestionRequest(tool({
      provider: "cursor",
      name: "AskQuestion",
      inputJson: JSON.stringify({
        questions: [{ id: "t", prompt: "Pick one", options: [{ id: "a", label: "A" }] }],
      }),
      outputText: null,
    }))
    expect(pending?.state).toBe("pending")
    expect(pending?.answer).toBeUndefined()
  })

  it("ignores non-question tools", () => {
    expect(artifactQuestionRequest(tool({ provider: "cursor", name: "Read" }))).toBeNull()
  })

  it("builds structured durable tool calls for non-question tools", () => {
    const call = artifactToolCall(tool({
      provider: "claude",
      name: "Bash",
      inputJson: JSON.stringify({ command: "npm test" }),
      outputText: "ok",
    }))

    expect(call).toEqual({
      kind: "tool",
      state: "output-available",
      toolName: "Bash",
      args: { command: "npm test" },
      output: "ok",
    })
  })

  it("classifies denied tool calls from artifact rejection output", () => {
    const call = artifactToolCall(tool({
      provider: "claude",
      name: "Bash",
      inputJson: JSON.stringify({ command: "rm -rf build" }),
      outputText: "[error] The user doesn't want to proceed with this tool use.",
    }))

    expect(call?.state).toBe("output-denied")
  })
})
