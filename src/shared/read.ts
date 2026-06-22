import { Schema } from "effect"
import { ChatId } from "./ids.js"
import { Chat } from "./chat.js"
import { ChatMessage, ChatMessageRole } from "./chat-message.js"
import { Work, WorkComment, WorkStatus } from "./work.js"

/**
 * **The core read surface** — `arc.search` (find what matches an intent/filter)
 * and `arc.get` (hydrate a specific ref fully). The bet recorded in
 * `work_01kv424crtexttwx0pgwsmn787`: Arc MCP should collapse its growing set of
 * narrow read tools (`work_list`, `work_get`, `work_for_target`, …) toward a
 * small `prime + search + get` triad so the surface stays legible to agents as
 * the domain grows.
 *
 * This is v1 — deliberately narrow, per the converged review:
 *  - typed result headers with a **rigid shared shape** ({@link ArcSearchHit}),
 *    so an agent reads any kind's hit the same way and calls `arc.get` on `ref`
 *    deterministically;
 *  - **opaque pagination** ({@link ArcSearchResult.nextCursor}) in the contract
 *    from day one, even though the backing implementation is a simple offset;
 *  - **batch-first hydration** ({@link ArcGetParams.refs}), single-ref as a
 *    convenience;
 *  - **structured filters**, never a natural-language-only blob.
 *
 * Searchable kinds are `work`, `chat`, and `message` (a chat-scoped timeline
 * row); `arc.get` additionally hydrates a `message_…` ref to its full row.
 * `comment`, `session`, and `attention` are contractually anticipated
 * ({@link ArcSearchKind} stays closed) and land once each has a first-class
 * index and hydration path.
 *
 * Visibility: work/chat/message reads are workspace-scoped. The caller anchors
 * the scope with `filters.chatId`; Arc derives the workspace from that chat and
 * never treats the whole local profile as an implicit global work queue.
 */

// ── search ────────────────────────────────────────────────────────────────────

/** The entity kinds `arc.search` indexes. `message` is a chat-scoped timeline
 * row (a conversational message OR a tool call — same `chat_messages` table),
 * surfaced only when `filters.chatId` is set; widening to comment/session is
 * additive. */
export const ArcSearchKind = Schema.Literals(["work", "chat", "message"])
export type ArcSearchKind = typeof ArcSearchKind.Type

/** How to order a result set. `relevance` ranks by match quality (only meaningful
 * with a `query`); `updated`/`created` are recency orders. */
export const ArcSearchSort = Schema.Literals(["relevance", "updated", "created"])
export type ArcSearchSort = typeof ArcSearchSort.Type

/** Structured narrowing. Each filter is honored only by the kinds it applies to
 * (`status`/`labels` are work-only; `chatId` anchors work search to the chat's
 * workspace and selects that chat) — never a kind-specific field bolted onto
 * the shared envelope. */
export const ArcSearchFilters = Schema.Struct({
  status: Schema.optional(Schema.Array(WorkStatus)),
  labels: Schema.optional(Schema.Array(Schema.String)),
  chatId: Schema.optional(ChatId),
})
export type ArcSearchFilters = typeof ArcSearchFilters.Type

export const ArcSearchParams = Schema.Struct({
  /** Free-text terms, whitespace-split; a hit matches when every term appears
   * (case-insensitively) in its searchable text. Omit for a pure filter/browse. */
  query: Schema.optional(Schema.String),
  /** Restrict to these kinds; defaults to `["work"]` (the work queue is the
   * dominant read). Work/chat searches require `filters.chatId` so Arc can derive
   * the workspace boundary. */
  kinds: Schema.optional(Schema.Array(ArcSearchKind)),
  filters: Schema.optional(ArcSearchFilters),
  /** Defaults to `relevance` when `query` is set, else `updated`. */
  sort: Schema.optional(ArcSearchSort),
  /** Page size; defaults to 20. */
  limit: Schema.optional(Schema.Number),
  /** Opaque cursor from a prior result's `nextCursor`; omit for the first page. */
  cursor: Schema.optional(Schema.String),
})
export type ArcSearchParams = typeof ArcSearchParams.Type

/** How a `message`-kind row presents in the timeline — a conversational
 * `message`, a `tool` call, or a `request` (a question awaiting the user). */
export const ArcMessageRowKind = Schema.Literals(["message", "tool", "request"])
export type ArcMessageRowKind = typeof ArcMessageRowKind.Type

/** Operational state of a timeline row, derived from the tool call's state (or
 * the message status for non-tool rows). `pending` covers a tool awaiting its
 * result or approval — the signal the debug case keys on. */
export const ArcMessageRowStatus = Schema.Literals(["pending", "completed", "errored", "denied"])
export type ArcMessageRowStatus = typeof ArcMessageRowStatus.Type

/** Thin typed metadata for a `message`-kind hit (absent for work/chat). Carries
 * just enough to answer "which tool calls are pending, in what order/time?" from
 * the search result alone — `arc.get(message_…)` hydrates the full row. */
export const ArcMessageHitMeta = Schema.Struct({
  chatId: ChatId,
  role: ChatMessageRole,
  rowKind: ArcMessageRowKind,
  /** the tool invoked, for `tool` rows; absent otherwise */
  toolName: Schema.optional(Schema.String),
  status: Schema.optional(ArcMessageRowStatus),
  /** 0-based position in the chat's displayed timeline (render order). */
  ordinal: Schema.Number,
  occurredAt: Schema.String,
})
export type ArcMessageHitMeta = typeof ArcMessageHitMeta.Type

/**
 * A single search result — the **rigid header** every kind returns: an agent
 * decides from `kind`/`title`/`preview` whether to hydrate, then calls
 * `arc.get({ refs: [ref] })`. `score` is the relevance signal (present only when
 * ranked by a query), `null` otherwise. `message` carries thin kind-specific
 * timeline metadata, populated only for `message`-kind hits.
 */
export const ArcSearchHit = Schema.Struct({
  ref: Schema.String,
  kind: ArcSearchKind,
  title: Schema.String,
  /** A short, body-derived snippet — enough to decide on without hydrating. */
  preview: Schema.String,
  updatedAt: Schema.String,
  score: Schema.NullOr(Schema.Number),
  message: Schema.optional(ArcMessageHitMeta),
})
export type ArcSearchHit = typeof ArcSearchHit.Type

export const ArcSearchResult = Schema.Struct({
  hits: Schema.Array(ArcSearchHit),
  /** The total matches across all pages (so a caller knows more exist). */
  total: Schema.Number,
  /** Pass back as `cursor` for the next page; `null` when this is the last page. */
  nextCursor: Schema.NullOr(Schema.String),
})
export type ArcSearchResult = typeof ArcSearchResult.Type

// ── get ─────────────────────────────────────────────────────────────────────

/** Optional hydration extras. `comments` (default on for work) attaches a work
 * item's comment thread; drop it for a lighter payload. */
export const ArcGetInclude = Schema.Literals(["comments"])
export type ArcGetInclude = typeof ArcGetInclude.Type

export const ArcGetParams = Schema.Struct({
  /** The refs to hydrate — batch-first. */
  refs: Schema.optional(Schema.Array(Schema.String)),
  /** Single-ref convenience; merged with `refs`. */
  ref: Schema.optional(Schema.String),
  /** Defaults to `["comments"]`. Pass `[]` to hydrate work without its thread. */
  include: Schema.optional(Schema.Array(ArcGetInclude)),
})
export type ArcGetParams = typeof ArcGetParams.Type

/** A hydrated work item plus (when requested) its comment thread. */
export const ArcWorkEntity = Schema.Struct({
  _tag: Schema.Literal("work"),
  work: Work,
  comments: Schema.Array(WorkComment),
  olderRevisionCommentCount: Schema.Number,
})
export type ArcWorkEntity = typeof ArcWorkEntity.Type

/** A hydrated chat. Stays a cheap header — the ordered timeline is a paginated
 * `arc.search({ kinds: ["message"], filters: { chatId } })` concern, never
 * attached here. */
export const ArcChatEntity = Schema.Struct({
  _tag: Schema.Literal("chat"),
  chat: Chat,
})
export type ArcChatEntity = typeof ArcChatEntity.Type

/** A fully hydrated chat-message row — the conversational text/thinking, or a
 * tool call's name/input/output/state. The one row a caller drilled into from a
 * `message`-kind search hit. */
export const ArcMessageEntity = Schema.Struct({
  _tag: Schema.Literal("message"),
  message: ChatMessage,
})
export type ArcMessageEntity = typeof ArcMessageEntity.Type

/** The canonical hydrated form of any Arc ref `arc.get` knows. Discriminated by
 * `_tag` so a caller switches on kind without re-parsing the ref. */
export const ArcEntity = Schema.Union([ArcWorkEntity, ArcChatEntity, ArcMessageEntity])
export type ArcEntity = typeof ArcEntity.Type

export const ArcGetResult = Schema.Struct({
  entities: Schema.Array(ArcEntity),
  /** Refs that resolved to nothing (unknown id, or a kind `arc.get` can't
   * hydrate yet) — never an error, so a batch with one bad ref still returns the
   * rest. */
  notFound: Schema.Array(Schema.String),
})
export type ArcGetResult = typeof ArcGetResult.Type
