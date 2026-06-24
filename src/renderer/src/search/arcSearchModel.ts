import type { ArcEntity, ArcSearchHit, ArcSearchKind, ArcSearchParams } from "../../../shared/read.js"
import type { Chat } from "../../../shared/chat.js"
import type { ChatId, WorkId, WorkspaceId } from "../../../shared/ids.js"

export type SearchScope = "all" | "currentChat"

export interface ArcSearchDraft {
  readonly query: string
  readonly kinds: ReadonlySet<ArcSearchKind>
  readonly scope: SearchScope
  readonly currentWorkspaceId?: WorkspaceId
  readonly currentChatId?: ChatId
}

export type SearchOpenTarget =
  | { readonly kind: "work"; readonly workId: WorkId }
  | { readonly kind: "chat"; readonly chatId: ChatId }
  | { readonly kind: "message"; readonly chatId: ChatId }

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
  const kinds = Array.from(draft.kinds)
  const needsWorkspaceAnchor = draft.scope === "currentChat" && kinds.some((kind) => kind === "work" || kind === "chat")
  const needsChatAnchor = draft.scope === "currentChat" && kinds.includes("message")
  const filters = {
    ...(needsWorkspaceAnchor && draft.currentWorkspaceId ? { workspaceId: draft.currentWorkspaceId } : {}),
    ...(needsChatAnchor && draft.currentChatId ? { chatId: draft.currentChatId } : {}),
  }
  return {
    ...(query.length > 0 ? { query } : {}),
    kinds,
    ...(Object.keys(filters).length > 0 ? { filters } : {}),
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
): WorkspaceId | undefined => {
  if (target.kind === "work") return undefined
  return chats.find((chat) => chat.id === target.chatId)?.workspaceId
}
