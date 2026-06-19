import type { ArcEntity, ArcSearchHit, ArcSearchKind, ArcSearchParams } from "../../../shared/read.js"
import type { Chat } from "../../../shared/chat.js"

export type SearchScope = "all" | "currentChat"

export interface ArcSearchDraft {
  readonly query: string
  readonly kinds: ReadonlySet<ArcSearchKind>
  readonly scope: SearchScope
  readonly currentChatId?: string
}

export type SearchOpenTarget =
  | { readonly kind: "work"; readonly workId: string }
  | { readonly kind: "chat"; readonly chatId: string }
  | { readonly kind: "message"; readonly chatId: string }

export const labelForSearchHit = (hit: ArcSearchHit): string => {
  const meta = hit.message
  if (!meta) return hit.kind
  if (meta.rowKind === "tool") return meta.toolName ? `tool:${meta.toolName}` : "tool"
  if (meta.rowKind === "request") return meta.status ? `request:${meta.status}` : "request"
  return `message:${meta.role}`
}

/** A quiet, message-only context tag — `#<position> · <state>`. Work/chat hits
 * carry no subtitle (the kind badge + title already say everything); the opaque
 * `ref` and raw relevance `score` are debug noise, kept out of the palette. */
export const subtitleForSearchHit = (hit: ArcSearchHit): string => {
  const meta = hit.message
  if (!meta) return ""
  return `#${meta.ordinal + 1} · ${meta.status ?? meta.rowKind}`
}

export const buildArcSearchParams = (draft: ArcSearchDraft, cursor?: string): ArcSearchParams => {
  const query = draft.query.trim()
  return {
    ...(query.length > 0 ? { query } : {}),
    kinds: Array.from(draft.kinds),
    ...(draft.scope === "currentChat" && draft.currentChatId ? { filters: { chatId: draft.currentChatId } } : {}),
    limit: 12,
    ...(cursor ? { cursor } : {}),
  }
}

export const targetFromSearchHit = (
  hit: ArcSearchHit,
  entities: ReadonlyArray<ArcEntity>,
): SearchOpenTarget | undefined => {
  const entity = entities[0]
  if (entity?._tag === "work") return { kind: "work", workId: entity.work.id }
  if (entity?._tag === "chat") return { kind: "chat", chatId: entity.chat.id }
  if (entity?._tag === "message") return { kind: "message", chatId: entity.message.chatId }

  if (hit.kind === "message" && hit.message) return { kind: "message", chatId: hit.message.chatId }
  return undefined
}

export const workspaceIdForSearchTarget = (
  chats: ReadonlyArray<Chat>,
  target: SearchOpenTarget,
): string | undefined => {
  if (target.kind === "work") return undefined
  return chats.find((chat) => chat.id === target.chatId)?.workspaceId
}
