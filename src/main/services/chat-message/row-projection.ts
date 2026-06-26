/**
 * Read-side projection: turns a stored {@link ChatMessageRow} into the
 * {@link ChatMessage} the renderer consumes, plus the small classifiers the
 * service reads off a row (undecodable-request hiding, pending-request kind,
 * provider narrowing) and the title seed derived from a chat's user prompts.
 * Pure — no stores, no Effect.
 */
import { Option, Schema } from "effect"
import type { ChatMessageRow } from "../../db/schema.js"
import { ChatMessagePayload } from "../../../shared/chat-message.js"
import type { ChatMessage } from "../../../shared/chat-message.js"
import type { PendingRequest } from "../../../shared/chat-request.js"
import { ALL_PROVIDERS, type Provider } from "../../../shared/provider.js"

const decodePayload = Schema.decodeUnknownOption(ChatMessagePayload)

/** Tolerant: a malformed/legacy `request_json` degrades to no structured payload. */
export const parsePayload = (json: string | null): ChatMessage["payload"] => {
  if (!json) return undefined
  let value: unknown
  try {
    value = JSON.parse(json)
  } catch {
    return undefined
  }
  const decoded = decodePayload(value)
  return Option.isSome(decoded) ? decoded.value : undefined
}

/**
 * Classify a pending request row for the sidebar flag. Permission is no longer a
 * persisted request family (it lives only as the in-memory sidebar flag) and
 * `loadPendingRequests` already filters to `kind = 'question'`, so every persisted
 * pending request is a question. Kept as a function so the sidebar call site
 * stays stable if a second persisted family is added.
 */
export const pendingRequestKind = (_requestJson: string | null): PendingRequest["kind"] => "question"

// A `request` row whose payload no longer decodes is dropped rather than shown
// as raw body text. This is what retires legacy permission-request rows (their
// `kind: "permission"` payload no longer matches the question/tool payload union);
// a genuine question row always decodes.
export const isUndecodableRequestRow = (row: ChatMessageRow): boolean =>
  row.role === "request" && parsePayload(row.requestJson) === undefined

// target_sessions.provider is a bare string column; narrow it to the closed
// Provider union, dropping anything unrecognized rather than trusting the cast.
export const asProvider = (value: string | null | undefined): Provider | undefined =>
  value != null && (ALL_PROVIDERS as ReadonlyArray<string>).includes(value) ? (value as Provider) : undefined

// `provider` is session metadata derived at read from the row's target session —
// never read from the stored payload (legacy rows have none). The renderer reads
// it off the message envelope to key tool/request rows into the tool catalog.
export const rowToChatMessage = (row: ChatMessageRow, provider?: Provider): ChatMessage => ({
  _tag: "ChatMessage",
  id: row.id,
  chatId: row.chatId,
  targetSessionId: row.targetSessionId ?? undefined,
  ...(provider ? { provider } : {}),
  role: row.role as ChatMessage["role"],
  turnId: row.turnId ?? undefined,
  messageId: row.messageId ?? undefined,
  body: row.body,
  status: row.status as ChatMessage["status"],
  model: row.model ?? undefined,
  payload: parsePayload(row.requestJson),
  occurredAt: row.occurredAt,
  source: row.source,
})

export const titleSeedFromMessages = (
  rows: ReadonlyArray<ChatMessageRow>,
  fallback: string,
): string => {
  const userMessages = rows
    .filter((message) => message.role === "user" && message.status === "final")
    .sort((a, b) =>
      a.occurredAt === b.occurredAt
        ? a.id.localeCompare(b.id)
        : a.occurredAt.localeCompare(b.occurredAt),
    )
    .map((message) => message.body.trim())
    .filter((body) => body.length > 0)

  const seed = userMessages.length > 0 ? userMessages.slice(0, 3).join("\n\n") : fallback
  return seed.trim()
}
