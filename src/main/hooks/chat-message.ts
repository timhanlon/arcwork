import type { HookSignal } from "./signals.js"
import * as canon from "./canonical.js"
import { hookInputObj, str } from "./hook-input.js"
import type {
  ChatRequest,
  QuestionState,
  RequestQuestion,
} from "../../shared/chat-request.js"
import { decodeQuestionTool } from "../../shared/question-tools.js"
import { requestDedupKey, subagentDedupKey } from "../chat-message-keys.js"

export type ChatMessageUpsertMode = "insert" | "replace" | "replace_keep_time"

export interface ChatMessageDraft {
  readonly mode: ChatMessageUpsertMode
  readonly role: "user" | "assistant" | "subagent" | "request"
  readonly turnId: string
  readonly messageId: string | null
  readonly chunkIndex: number | null
  readonly body: string
  readonly status: "streaming" | "pending" | "final"
  /** model that produced an assistant/subagent draft, when the signal reports it */
  readonly model?: string | null
  /** structured payload for request-role drafts; the renderer dispatches on it */
  readonly request?: ChatRequest
  readonly dedupKey: string
}

const turnIdFrom = (signal: HookSignal, input: Record<string, unknown> | null): string =>
  signal.native.turnId ??
  str(input?.["turn_id"]) ??
  str(input?.["turnId"]) ??
  str(input?.["generation_id"]) ??
  str(input?.["generationId"]) ??
  signal.hookInputSha256.slice(0, 16)


const requireTargetSession = (signal: HookSignal): string | null => signal.arcTargetSessionId

const compactJson = (v: unknown): string => JSON.stringify(v, null, 2)

const requestDraft = (
  signal: HookSignal,
  input: Record<string, unknown> | null,
  requestId: string,
  title: string,
  bodyLines: ReadonlyArray<string>,
  status: "pending" | "final" = "pending",
  request?: ChatRequest,
): ChatMessageDraft | null => {
  const targetSessionId = requireTargetSession(signal)
  if (!targetSessionId) return null
  const turnId = signal.native.turnId ?? str(input?.["turn_id"]) ?? str(input?.["turnId"]) ??
    signal.native.sessionId ?? turnIdFrom(signal, input)
  const body = [`[${title}]`, ...bodyLines.filter((line) => line.trim().length > 0)].join("\n")
  return {
    mode: "replace",
    role: "request",
    turnId,
    messageId: requestId,
    chunkIndex: null,
    body,
    status,
    model: signal.native.model,
    ...(request ? { request } : {}),
    dedupKey: requestDedupKey(targetSessionId, requestId),
  }
}

const questionToolInput = (input: Record<string, unknown> | null): Record<string, unknown> | null => {
  const toolInput = input?.["tool_input"] ?? input?.["toolInput"]
  return toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? toolInput as Record<string, unknown>
    : null
}

const questionToolResultText = (input: Record<string, unknown> | null): string | undefined =>
  str(input?.["result"]) ??
  str(input?.["output"]) ??
  str(input?.["output_text"] ?? input?.["outputText"]) ??
  str(input?.["response"]) ??
  str(input?.["text"]) ??
  str(input?.["content"]) ??
  (input?.["tool_response"] === undefined ? undefined : compactJson(input["tool_response"])) ??
  undefined

const cursorQuestionDraft = (
  signal: HookSignal,
  input: Record<string, unknown> | null,
  state?: QuestionState,
  answer?: string,
): ChatMessageDraft | null => {
  const toolInput = questionToolInput(input)
  if (!toolInput) return null
  // The chosen option rides in the freeform result text; thread it through so
  // decode lifts the label onto each chip. Keep the raw text as a card-level
  // fallback only when it wasn't a structured "Selected option(s)" answer.
  const decoded = decodeQuestionTool(
    "cursor",
    str(input?.["tool_name"] ?? input?.["toolName"]),
    toolInput,
    answer,
  )
  if (!decoded) return null
  const toolUseId = str(input?.["tool_use_id"] ?? input?.["toolUseId"]) ?? signal.hookInputSha256.slice(0, 16)
  const cardAnswer = decoded.hasStructuredAnswer ? undefined : answer
  const request: ChatRequest = {
    kind: "question",
    state: state ?? "pending",
    title: decoded.title,
    questions: decoded.questions,
    ...(cardAnswer ? { answer: cardAnswer } : {}),
  }
  return requestDraft(
    signal,
    input,
    toolUseId,
    decoded.title,
    questionBodyLines(decoded.questions),
    state === "pending" || state === undefined ? "pending" : "final",
    request,
  )
}

const questionBodyLines = (questions: ReadonlyArray<RequestQuestion>): Array<string> => {
  const lines: Array<string> = []
  for (const q of questions) {
    if (q.header) lines.push(`(${q.header})`)
    lines.push(q.prompt)
    if (q.options.length > 0) {
      lines.push("Options:", ...q.options.map((o) => (o.description ? `- ${o.label} — ${o.description}` : `- ${o.label}`)))
    }
    if (q.answer) lines.push(`Answer: ${q.answer}`)
  }
  return lines
}

/**
 * Claude AskUserQuestion → question request. Decodes the raw `tool_input` /
 * `tool_response` with the wire-format schemas, then normalizes: the chosen
 * label lands on the question it answers (not flattened into a JSON blob), and
 * `header` / `multiSelect` survive. Falls back to the result text only when the
 * response isn't a structured answers map.
 */
const claudeUserQuestionDraft = (
  signal: HookSignal,
  input: Record<string, unknown> | null,
  state: QuestionState = "pending",
): ChatMessageDraft | null => {
  const toolInput = questionToolInput(input)
  if (!toolInput) return null
  // The chosen-answer map rides in `tool_response`, only present once answered.
  const rawResponse = state === "pending" ? undefined : input?.["tool_response"]
  const decoded = decodeQuestionTool(
    "claude",
    str(input?.["tool_name"] ?? input?.["toolName"]),
    toolInput,
    rawResponse,
  )
  if (!decoded) return null
  const toolUseId = str(input?.["tool_use_id"] ?? input?.["toolUseId"]) ?? signal.hookInputSha256.slice(0, 16)
  // Keep the legacy text answer only when there is no structured answers map to
  // lift onto each question (e.g. a failure with a plain-text response).
  const cardAnswer =
    state === "pending" || decoded.hasStructuredAnswer ? undefined : questionToolResultText(input)
  const request: ChatRequest = {
    kind: "question",
    state,
    title: decoded.title,
    questions: decoded.questions,
    ...(cardAnswer ? { answer: cardAnswer } : {}),
  }
  return requestDraft(
    signal,
    input,
    toolUseId,
    decoded.title,
    questionBodyLines(decoded.questions),
    state === "pending" ? "pending" : "final",
    request,
  )
}

const responseTextFromCursor = (input: Record<string, unknown> | null): string | null =>
  str(input?.["response"]) ??
  str(input?.["text"]) ??
  str(input?.["content"]) ??
  str(input?.["message"]) ??
  str(input?.["last_assistant_message"] ?? input?.["lastAssistantMessage"])

/**
 * A question request draft for the resolved provider, or null when the signal's
 * tool isn't a question tool. Claude decodes `AskUserQuestion` (answer lifted
 * from `tool_response`); Cursor decodes `AskQuestion` (answer taken from the
 * tool result text). Codex has no question tool, so it yields nothing.
 */
const questionDraft = (signal: HookSignal, state: QuestionState): ChatMessageDraft | null => {
  const input = hookInputObj(signal)
  if (signal.provider === "cursor") {
    const answer = state === "pending" ? undefined : questionToolResultText(input)
    return cursorQuestionDraft(signal, input, state, answer)
  }
  if (signal.provider === "claude") {
    return claudeUserQuestionDraft(signal, input, state)
  }
  return null
}

/**
 * A SubagentStop summary row. Claude/Codex carry the text on
 * `last_assistant_message` and a named `agent_type` distinguishes a real Task
 * subagent from Claude's implicit agents (suggested-next-message, recap) which
 * arrive with `agent_type: ""` and must be suppressed. Cursor carries a `summary`
 * and doesn't multiplex implicit agents, so it has no agent-type guard.
 */
const subagentDraft = (signal: HookSignal): ReadonlyArray<ChatMessageDraft> => {
  const input = hookInputObj(signal)
  const targetSessionId = requireTargetSession(signal)
  if (!targetSessionId) return []
  const body =
    signal.provider === "cursor"
      ? str(input?.["summary"]) ?? responseTextFromCursor(input)
      : str(input?.["last_assistant_message"] ?? input?.["lastAssistantMessage"])
  if (!body) return []
  if (signal.provider !== "cursor" && !canon.subagentType(signal)) return []
  const subagentId = canon.subagentId(signal) ?? "subagent"
  return [
    {
      mode: "replace",
      role: "subagent",
      turnId: turnIdFrom(signal, input),
      messageId: subagentId,
      chunkIndex: null,
      body,
      status: "final",
      model: signal.native.model,
      dedupKey: subagentDedupKey(targetSessionId, subagentId),
    },
  ]
}

/**
 * One dispatcher over the canonical event vocabulary, replacing the former
 * `map{Claude,Codex,Cursor}` triplet. Routing is the resolved provider (via
 * `canonicalEvent`), closing the divergence where this path used to route on the
 * *declared* provider while the activity path routed on the resolved one.
 *
 * Note what the hook no longer drafts: user prompts and assistant text are
 * transcript-owned (projectArtifactSession), and MessageDisplay deltas drive only
 * the ephemeral `arc:assistant-stream` overlay — so turn_start/turn_end/
 * message_display fall through to `[]`.
 */
export const hookSignalToChatMessageDrafts = (signal: HookSignal): ReadonlyArray<ChatMessageDraft> => {
  if (!signal.arcTargetSessionId) return []
  switch (canon.canonicalEvent(signal)) {
    case "permission_request": {
      // Claude routes AskUserQuestion through PermissionRequest; require the
      // tool-use id so a malformed permission prompt doesn't mint a question row.
      if (canon.toolName(signal) !== "AskUserQuestion" || !canon.toolUseId(signal)) return []
      const draft = claudeUserQuestionDraft(signal, hookInputObj(signal))
      return draft ? [draft] : []
    }
    case "tool_pre": {
      const draft = questionDraft(signal, "pending")
      return draft ? [draft] : []
    }
    case "tool_post": {
      const draft = questionDraft(signal, "answered")
      return draft ? [draft] : []
    }
    case "tool_post_failure": {
      const draft = questionDraft(signal, "failed")
      return draft ? [draft] : []
    }
    case "subagent_stop":
      return subagentDraft(signal)
    default:
      return []
  }
}
