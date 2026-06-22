/**
 * Pure artifact-session projection: turns the re-ingested transcript
 * ({@link ExtractedRows}) into the provider-neutral row specs the
 * ChatMessageService driver upserts. Everything here is free of stores and
 * pubsub — the only side-effecting seams are the optional reconcilers handed in
 * on {@link ArtifactProjectionContext}, which the service pre-wraps to never
 * fail. Splitting this out keeps ChatMessageService an orchestration boundary
 * and makes the projection rules unit-testable in isolation.
 */
import type { Effect } from "effect"
import type { ChatMessageRow } from "../../db/schema.js"
import type { ExtractedRows, MessageRow, ToolCallRow } from "../../ingest/db/schema.js"
import type { QuestionRequest } from "../../../shared/chat-request.js"
import type { ToolCall as ToolCallData } from "../../../shared/tool-call.js"
import { decodeQuestionTool } from "../../../shared/question-tools.js"
import { type ChatId, newArcId, type TargetId } from "../../../shared/ids.js"
import { str } from "../../hooks/hook-input.js"
import {
  assistantDedupKey,
  metaDedupKey,
  recapDedupKey,
  requestDedupKey,
  toolDedupKey,
  userDedupKey,
} from "../../chat-message-keys.js"

const parsedToolInput = (tool: ToolCallRow): Record<string, unknown> | null => {
  if (!tool.inputJson) return null
  let input: unknown
  try {
    input = JSON.parse(tool.inputJson)
  } catch {
    return null
  }
  if (!input || typeof input !== "object" || Array.isArray(input)) return null
  return input as Record<string, unknown>
}

const artifactQuestionProjection = (tool: ToolCallRow): QuestionRequest | null => {
  const input = parsedToolInput(tool)
  if (!input) return null
  // The response bytes live in a different field per provider: Claude's
  // chosen-answer map rides in the structured `rawJson` sidecar (`outputText` is
  // only the human sentence), while Codex nests its answer in `outputText`.
  // Cursor ignores `rawResponse` and reads its answer off the result text below.
  let rawResponse: unknown
  if (tool.provider === "claude" && tool.rawJson) {
    try {
      rawResponse = JSON.parse(tool.rawJson)
    } catch {
      rawResponse = undefined
    }
  } else if (tool.provider === "codex" && tool.outputText) {
    try {
      rawResponse = JSON.parse(tool.outputText)
    } catch {
      rawResponse = undefined
    }
  } else if (tool.provider === "cursor") {
    // Cursor carries its answer as the freeform result text; decode parses the
    // chosen option ids out of it and maps them back to labels on each chip.
    rawResponse = str(tool.outputText)
  }
  const decoded = decodeQuestionTool(tool.provider, tool.name, input, rawResponse)
  if (!decoded) return null

  // State and card-answer are inferred from the presence of output here — the
  // artifact path has no lifecycle event to read. Claude and Cursor lift the
  // chosen option onto each chip, so they drop the plain sentence to avoid
  // showing the answer twice; other providers keep the result text on the card.
  const text = str(tool.outputText)
  if (tool.provider === "claude" || tool.provider === "cursor") {
    const cardAnswer = decoded.hasStructuredAnswer ? undefined : text
    return {
      kind: "question",
      state: decoded.hasStructuredAnswer || text != null ? "answered" : "pending",
      title: decoded.title,
      questions: decoded.questions,
      ...(cardAnswer ? { answer: cardAnswer } : {}),
    }
  }
  return {
    kind: "question",
    state: text ? "answered" : "pending",
    title: decoded.title,
    questions: decoded.questions,
    ...(text ? { answer: text } : {}),
  }
}

const questionLines = (request: QuestionRequest): Array<string> => {
  const lines = [`[${request.title ?? "Question"}]`]
  for (const q of request.questions) {
    if (q.header) lines.push(`(${q.header})`)
    lines.push(q.prompt)
    if (q.options.length > 0) {
      lines.push(
        "Options:",
        ...q.options.map((o) => `- ${o.description ? `${o.label} — ${o.description}` : o.label}`),
      )
    }
    if (q.answer) lines.push(`Answer: ${q.answer}`)
  }
  if (request.answer) lines.push("", request.answer)
  return lines
}

export const artifactQuestionBody = (tool: ToolCallRow): string | null => {
  const request = artifactQuestionProjection(tool)
  return request ? questionLines(request).join("\n") : null
}

/** Structured form of {@link artifactQuestionBody}, dispatched on by the renderer. */
export const artifactQuestionRequest = (tool: ToolCallRow): QuestionRequest | null =>
  artifactQuestionProjection(tool)

const toolStateFromOutput = (output: string | null): ToolCallData["state"] => {
  if (!output) return "input-available"
  const lower = output.toLowerCase()
  if (lower.includes("user doesn't want to proceed") || lower.includes("user does not want to proceed")) {
    return "output-denied"
  }
  // Only the provider's own error envelope marks failure — a bare substring
  // "error" anywhere in normal output (grep hits, "0 errors", a stack trace in
  // a successful read) must not flip the state pill to error.
  if (lower.startsWith("[error]")) return "output-error"
  return "output-available"
}

export const artifactToolCall = (tool: ToolCallRow): ToolCallData | null => {
  const toolName = str(tool.name) ?? str(tool.kind)
  if (!toolName) return null
  let args: unknown
  if (tool.inputJson) {
    try {
      args = JSON.parse(tool.inputJson)
    } catch {
      args = tool.inputJson
    }
  }
  return {
    kind: "tool",
    state: toolStateFromOutput(tool.outputText),
    toolName,
    ...(args === undefined ? {} : { args }),
    ...(tool.outputText ? { output: tool.outputText } : {}),
  }
}

const toolLines = (tool: ToolCallData): Array<string> => {
  const lines = [`[Tool: ${tool.toolName}]`, `State: ${tool.state}`]
  if (tool.args !== undefined) {
    lines.push("Input:", typeof tool.args === "string" ? tool.args : JSON.stringify(tool.args, null, 2))
  }
  if (tool.output) lines.push("Output:", tool.output)
  return lines
}

/**
 * The fixed shape of an artifact-projected chat row. Each loop in
 * {@link ARTIFACT_KINDS} supplies only what differs — role, identity, body,
 * status, timing, payload — while id / chat / target / source / chunkIndex are
 * filled here, so the projected-row shape lives in one place rather than being
 * re-spelled at every message kind.
 */
export const artifactRow = (
  target: { readonly id: TargetId; readonly chatId: ChatId },
  provider: string,
  fields: {
    readonly role: ChatMessageRow["role"]
    readonly messageId: string | null
    readonly body: string
    readonly status: ChatMessageRow["status"]
    readonly occurredAt: string
    readonly dedupKey: string
    readonly requestJson?: string | null
    readonly model?: string | null
  },
): ChatMessageRow => ({
  id: newArcId("message"),
  chatId: target.chatId,
  targetSessionId: target.id,
  role: fields.role,
  turnId: null,
  messageId: fields.messageId,
  chunkIndex: null,
  body: fields.body,
  status: fields.status,
  model: fields.model ?? null,
  requestJson: fields.requestJson ?? null,
  occurredAt: fields.occurredAt,
  source: `artifact:${provider}`,
  dedupKey: fields.dedupKey,
})

const isoWithOffset = (base: string, offsetMs: number): string | null => {
  const ms = Date.parse(base)
  if (!Number.isFinite(ms)) return null
  return new Date(ms + offsetMs).toISOString()
}

const artifactMessageText = (message: MessageRow): string | null =>
  str(message.text) ?? str(message.thinking)

const matchingProjectedMessageTime = (
  source: MessageRow | undefined,
  targetSessionId: string,
  projected: ReadonlyArray<ChatMessageRow>,
): string | null => {
  if (!source) return null
  const text = artifactMessageText(source)
  if (!text) return null
  return projected.find((message) =>
    message.targetSessionId === targetSessionId &&
    message.role === source.role &&
    message.body === text
  )?.occurredAt ?? null
}

const artifactToolOccurredAt = (
  ctx: ArtifactProjectionContext,
  tool: ToolCallRow,
): string => {
  const { rows } = ctx
  const before = [...rows.messages].reverse().find((message) => message.ordinal < tool.ordinal)
  const after = rows.messages.find((message) => message.ordinal > tool.ordinal)
  const beforeAt = before?.createdAt ?? matchingProjectedMessageTime(before, ctx.target.id, ctx.projected)
  if (beforeAt) return isoWithOffset(beforeAt, Math.max(1, tool.ordinal - (before?.ordinal ?? tool.ordinal))) ?? beforeAt

  const afterAt = after?.createdAt ?? matchingProjectedMessageTime(after, ctx.target.id, ctx.projected)
  if (afterAt) return isoWithOffset(afterAt, -Math.max(1, (after?.ordinal ?? tool.ordinal) - tool.ordinal)) ?? afterAt

  // No native time on either neighbour (Cursor): observation time spread by
  // ordinal, instead of pinning to the (ever-staler) session-start time.
  return fallbackTime(ctx, tool.ordinal)
}

/**
 * The provider-neutral identity + payload a projection kind produces for one
 * source record (a transcript message or a tool call). The driver in the service
 * turns it into a ChatMessageRow, runs the optional reconcile, and upserts — so a
 * kind spells out only what differs. `reconcile` lets a kind claim a row by
 * rekeying an existing one in place (composer echo -> user, hook user row ->
 * meta) and short-circuit the upsert.
 */
export type ArtifactRowSpec = {
  readonly role: ChatMessageRow["role"]
  readonly messageId: string
  readonly body: string
  readonly status: ChatMessageRow["status"]
  readonly occurredAt: string
  readonly dedupKey: string
  readonly label: string
  readonly requestJson?: string | null
  readonly model?: string | null
  readonly reconcile?: (row: ChatMessageRow) => Effect.Effect<boolean, never>
}

export type ArtifactProjectionContext = {
  readonly rows: ExtractedRows
  readonly target: { readonly id: TargetId; readonly chatId: ChatId }
  readonly projected: ReadonlyArray<ChatMessageRow>
  // Wall-clock captured once per projection pass. Used only when the transcript
  // has no stable session clock.
  readonly projectionTime: string
  // Reconcile a composer optimistic-echo row onto the transcript user row, in
  // place. The service supplies it only when the optimistic echo is enabled;
  // absent → userKind falls through to a fresh insert. Pre-wrapped to never fail.
  readonly reconcileComposerUser?: (row: ChatMessageRow) => Effect.Effect<boolean, never>
  // Relabel a hook-projected user row as meta, in place. Pre-wrapped to never fail.
  readonly relabelHookUserAsMeta: (params: {
    readonly targetSessionId: string
    readonly body: string
    readonly dedupKey: string
    readonly messageId: string
  }) => Effect.Effect<boolean, never>
}

/** Every row spec for one message role (or for tool calls). */
export type ArtifactProjectionKind = (ctx: ArtifactProjectionContext) => ReadonlyArray<ArtifactRowSpec>

/**
 * Per-item time for a record that carries no native timestamp (Cursor blobs
 * carry none). Anchor to the transcript/session clock when present so re-ingest
 * produces stable timestamps, then spread by the shared display `ordinal` so
 * messages and tool calls keep their interleaved order.
 */
const fallbackTime = (ctx: ArtifactProjectionContext, ordinal: number): string =>
  isoWithOffset(ctx.rows.session.createdAt ?? ctx.projectionTime, ordinal) ??
  ctx.rows.session.createdAt ??
  ctx.projectionTime

/**
 * Map every transcript message of one role to a row spec. The per-message timing
 * rule (the record's own clock, else the session's) lives here once, so each
 * message kind only spells out body, identity, and dedup key.
 */
const messageRowSpecs = (
  ctx: ArtifactProjectionContext,
  role: MessageRow["role"],
  build: (message: MessageRow, occurredAt: string) => ArtifactRowSpec | null,
): ReadonlyArray<ArtifactRowSpec> => {
  const specs: Array<ArtifactRowSpec> = []
  for (const message of ctx.rows.messages) {
    if (message.role !== role) continue
    const occurredAt = message.createdAt ?? fallbackTime(ctx, message.ordinal)
    const spec = build(message, occurredAt)
    if (spec) specs.push(spec)
  }
  return specs
}

// A question tool projects as a request row; any other tool as a tool row.
// Identity is the tool id (stable across `--resume`, unlike nativeSessionId);
// no turn id, since the turn_id column is only read for hook permission
// correlation, which never matches these.
const toolCallKind: ArtifactProjectionKind = (ctx) => {
  const specs: Array<ArtifactRowSpec> = []
  for (const tool of ctx.rows.toolCalls) {
    const toolId = tool.nativeToolId ?? tool.id
    const occurredAt = artifactToolOccurredAt(ctx, tool)
    const status: ChatMessageRow["status"] = tool.outputText ? "final" : "pending"
    const questionBody = artifactQuestionBody(tool)
    const questionRequest = artifactQuestionRequest(tool)
    if (questionBody && questionRequest) {
      specs.push({
        role: "request",
        messageId: toolId,
        body: questionBody,
        status,
        requestJson: JSON.stringify(questionRequest),
        occurredAt,
        dedupKey: requestDedupKey(ctx.target.id, toolId),
        label: `artifact chat message (${tool.name ?? "tool"})`,
      })
      continue
    }
    const toolCall = artifactToolCall(tool)
    if (!toolCall) continue
    specs.push({
      role: "tool",
      messageId: toolId,
      body: toolLines(toolCall).join("\n"),
      status,
      requestJson: JSON.stringify(toolCall),
      occurredAt,
      dedupKey: toolDedupKey(ctx.target.id, toolId),
      label: `artifact tool message (${tool.name ?? "tool"})`,
    })
  }
  return specs
}

// Assistant text is artifact-owned: the live hook stream feeds only the
// ephemeral StreamingMessage (never stored), so the durable bubble comes from
// the disk record. createdAt is the provider's own per-block clock — the one
// ordering clock that interleaves correctly with tool rows (the cross-clock
// skew between hook receive-time and transcript-time was the ordering bug).
const assistantKind: ArtifactProjectionKind = (ctx) =>
  messageRowSpecs(ctx, "assistant", (message, occurredAt) => {
    const body = artifactMessageText(message)
    if (!body) return null
    const messageId = message.nativeMessageId ?? message.id
    return {
      role: "assistant",
      messageId,
      body,
      status: "final",
      model: message.model,
      occurredAt,
      dedupKey: assistantDedupKey(ctx.target.id, messageId),
      label: "artifact assistant",
    }
  })

// Recaps (Claude away_summary) only exist on disk: at the hook seam a recap
// is indistinguishable from the suggested-next-message (both SubagentStop
// with empty agent_type) and is suppressed there, whereas the extractor tags
// the unambiguous `away_summary` record as a `recap` MessageRow.
const recapKind: ArtifactProjectionKind = (ctx) =>
  messageRowSpecs(ctx, "recap", (message, occurredAt) => {
    const body = str(message.text)
    if (!body) return null
    const recapId = message.nativeMessageId ?? message.id
    return {
      role: "recap",
      messageId: recapId,
      body,
      status: "final",
      occurredAt,
      dedupKey: recapDedupKey(ctx.target.id, recapId),
      label: "artifact recap",
    }
  })

// User prompts are transcript-owned: the message uuid is unique per submit
// (identical text included) and stable across `--resume`, the durable
// identity the hook's content-hash fallback could not give — two identical
// prompts no longer collide onto one row. When the optimistic composer echo
// is enabled, reconcile claims its row in place so there is no transient
// duplicate; otherwise the bubble lands fresh via the upsert.
const userKind: ArtifactProjectionKind = (ctx) =>
  messageRowSpecs(ctx, "user", (message, occurredAt) => {
    const body = str(message.text)
    if (!body) return null
    const userId = message.nativeMessageId ?? message.id
    const reconcileComposerUser = ctx.reconcileComposerUser
    return {
      role: "user",
      messageId: userId,
      body,
      status: "final",
      occurredAt,
      dedupKey: userDedupKey(ctx.target.id, userId),
      label: "artifact user",
      reconcile: reconcileComposerUser ? (row) => reconcileComposerUser(row) : undefined,
    }
  })

// Programmatic prompts (ScheduleWakeup/`/loop` re-submissions, skill
// base-directory injections) carry `isMeta: true` on disk but not on the hook
// stream, which already projected the re-submitted ones as plain user rows.
// Reconcile relabels that hook row in place (user -> meta); only a prompt that
// never fired UserPromptSubmit (e.g. a skill injection) falls through to a
// fresh insert. Same metaDedupKey either way, so re-ingest converges.
const metaKind: ArtifactProjectionKind = (ctx) =>
  messageRowSpecs(ctx, "meta", (message, occurredAt) => {
    const body = str(message.text)
    if (!body) return null
    const metaId = message.nativeMessageId ?? message.id
    return {
      role: "meta",
      messageId: metaId,
      body,
      status: "final",
      occurredAt,
      dedupKey: metaDedupKey(ctx.target.id, metaId),
      label: "artifact meta",
      reconcile: (row) =>
        ctx.relabelHookUserAsMeta({
          targetSessionId: ctx.target.id,
          body: row.body,
          dedupKey: row.dedupKey,
          messageId: metaId,
        }),
    }
  })

/**
 * The projection kinds, in projection order. The driver in the service owns the
 * shared filter -> build row -> reconcile -> upsert skeleton, so a new message
 * kind is one entry here instead of a seventh copied loop.
 */
export const ARTIFACT_KINDS: ReadonlyArray<ArtifactProjectionKind> = [
  toolCallKind,
  assistantKind,
  recapKind,
  userKind,
  metaKind,
]
