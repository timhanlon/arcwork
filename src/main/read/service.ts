import { Context, Effect, Layer, Schema } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { WorkService } from "../work/service.js"
import { ChatService } from "../services/ChatService.js"
import { ChatMessageService } from "../services/ChatMessageService.js"
import { ArcStore } from "../db/store.js"
import type { ArcRequestError } from "../errors.js"
import type { ChatMessage } from "../../shared/chat-message.js"
import { WorkId } from "../../shared/ids.js"
import type {
  ArcEntity,
  ArcGetParams,
  ArcGetResult,
  ArcMessageHitMeta,
  ArcMessageRowKind,
  ArcMessageRowStatus,
  ArcSearchHit,
  ArcSearchParams,
  ArcSearchResult,
} from "../../shared/read.js"

/**
 * The **core read surface** behind `arc.search` and `arc.get` — the v1 of the
 * `prime + search + get` triad (`work_01kv424crtexttwx0pgwsmn787`). It composes
 * the existing domain verbs ({@link WorkService}, {@link ChatService}) rather
 * than reaching into stores, so it inherits their projections and stays a thin
 * read-only seam. The MCP transport decodes into these two methods; nothing here
 * knows about MCP.
 *
 * v1 indexes two kinds — `work` and `chat`. Ranking and pagination are
 * deliberately simple (in-memory merge, occurrence-count relevance, offset
 * cursor) but sit behind an opaque contract, so a real index/cursor can replace
 * the backing without an external change.
 */
export class ReadService extends Context.Service<
  ReadService,
  {
    readonly search: (params: ArcSearchParams) => Effect.Effect<ArcSearchResult, SqlError>
    readonly get: (
      params: ArcGetParams,
    ) => Effect.Effect<ArcGetResult, SqlError | ArcRequestError>
  }
>()("arcwork/ReadService") {}

const PREVIEW_MAX = 280

/** A short, single-line snippet of `text` for a result header. */
const preview = (text: string): string => {
  const flat = text.replace(/\s+/g, " ").trim()
  return flat.length > PREVIEW_MAX ? `${flat.slice(0, PREVIEW_MAX - 1)}…` : flat
}

/** Cheap relevance: total case-insensitive occurrences of every term in `text`.
 * Discriminates a title/body that mentions a term once from one saturated with
 * it — enough to order a page without a real ranker. */
const scoreText = (terms: ReadonlyArray<string>, text: string): number => {
  const haystack = text.toLowerCase()
  let score = 0
  for (const term of terms) {
    if (term.length === 0) continue
    let from = 0
    for (;;) {
      const at = haystack.indexOf(term, from)
      if (at === -1) break
      score += 1
      from = at + term.length
    }
  }
  return score
}

/** Offset cursors are opaque to callers (base64'd JSON) so the pagination
 * contract doesn't leak the offset implementation. A malformed cursor restarts
 * from the top rather than erroring — a stale cursor is not a client fault. */
const encodeCursor = (offset: number): string =>
  Buffer.from(JSON.stringify({ o: offset }), "utf8").toString("base64")

const decodeCursor = (cursor: string | undefined): number => {
  if (!cursor) return 0
  try {
    const parsed = JSON.parse(Buffer.from(cursor, "base64").toString("utf8")) as { o?: unknown }
    return typeof parsed.o === "number" && parsed.o >= 0 ? Math.floor(parsed.o) : 0
  } catch {
    return 0
  }
}

type SearchDocumentRow = {
  readonly ref: string
  readonly kind: "work" | "chat" | "message"
  readonly sourceKind: string
  readonly chatId: string | null
  readonly workspaceId: string | null
  readonly title: string
  readonly body: string
  readonly labelsJson: string
  readonly status: string | null
  readonly createdAt: string
  readonly updatedAt: string
  readonly rank: number | null
}

const ftsPhrase = (term: string): string => `"${term.replaceAll("\"", "\"\"")}"`

// OR, not AND: agents query with concept-bags ("orchestration streaming IPC RPC
// cut spawn"), so a conjunction matches nothing. Any term qualifies a row and
// bm25() ranks the ones covering more (and rarer) terms to the top.
const ftsQuery = (terms: ReadonlyArray<string>): string => terms.map(ftsPhrase).join(" OR ")

const hasEveryLabel = (labelsJson: string, expected: ReadonlyArray<string>): boolean => {
  if (expected.length === 0) return true
  try {
    const labels = JSON.parse(labelsJson)
    return Array.isArray(labels) && expected.every((label) => labels.includes(label))
  } catch {
    return false
  }
}

/** A work ref is a full `work_…` TypeID — validated through the {@link WorkId}
 * schema, so the `ref is WorkId` narrowing is honest (a prefix-only string like
 * `work_short` is rejected). Its pattern also excludes the substrate's
 * `work_rev_…`/`work_edge_…`, which share the textual prefix but aren't
 * independently hydratable. */
const isWorkRef: (ref: string) => ref is WorkId = Schema.is(WorkId)

/** A chat-message row ref (`message_…`) — both conversational rows and tool
 * calls share this id space (the `chat_messages` table). */
const isMessageRef = (ref: string): boolean => ref.startsWith("message_")

/** Classify a timeline row: a tool call, a request (question), or plain message.
 * Reads the decoded payload first (the source of truth), falling back to role. */
const rowKindOf = (m: ChatMessage): ArcMessageRowKind =>
  m.payload?.kind === "tool" || m.role === "tool"
    ? "tool"
    : m.payload?.kind === "question" || m.role === "request"
      ? "request"
      : "message"

/** Operational state of a row. Tool rows derive it from the tool call's state
 * (`pending` = awaiting result or approval — the debug signal); other rows from
 * the message status. `streaming`/`pending` both read as `pending`. */
const statusOf = (m: ChatMessage): ArcMessageRowStatus | undefined => {
  if (m.payload?.kind === "tool") {
    switch (m.payload.state) {
      case "input-available":
      case "approval-requested":
        return "pending"
      case "output-available":
        return "completed"
      case "output-error":
        return "errored"
      case "output-denied":
        return "denied"
    }
  }
  return m.status === "final" ? "completed" : "pending"
}

/** Build the thin per-row metadata carried on a `message`-kind search hit.
 * `ordinal` is the row's 0-based position in the chat's displayed timeline. */
const messageHitMeta = (m: ChatMessage, ordinal: number): ArcMessageHitMeta => {
  const rowKind = rowKindOf(m)
  const toolName = m.payload?.kind === "tool" ? m.payload.toolName : undefined
  const status = statusOf(m)
  return {
    chatId: m.chatId,
    role: m.role,
    rowKind,
    ...(toolName ? { toolName } : {}),
    ...(status ? { status } : {}),
    ordinal,
    occurredAt: m.occurredAt,
  }
}

export const ReadServiceLive = Layer.effect(
  ReadService,
  Effect.gen(function* () {
    const work = yield* WorkService
    const chats = yield* ChatService
    const chatMessages = yield* ChatMessageService
    const arc = yield* ArcStore
    const sql = yield* SqlClient

    const searchDocuments = (args: {
      readonly kinds: ReadonlyArray<"work" | "chat">
      readonly terms: ReadonlyArray<string>
      readonly filters: NonNullable<ArcSearchParams["filters"]>
      readonly includeClosedWorkByDefault: boolean
      readonly workspaceId: string
    }) => {
      const where: Array<string> = []
      const values: Array<string> = []
      if (args.kinds.length === 0) return Effect.succeed([] as ReadonlyArray<SearchDocumentRow>)
      where.push(`d.kind IN (${args.kinds.map(() => "?").join(", ")})`)
      values.push(...args.kinds)
      // Scope to the whole project, not the one workspace: a repository's main
      // checkout and its worktrees are distinct workspaces but share their work
      // and chats, so anchor by repository when the workspace has one. A plain
      // (non-git) folder has no repository and stays scoped to just itself.
      where.push(`d.workspace_id IN (
        SELECT w.id FROM workspaces w
        WHERE w.id = ?
           OR (w.repository_id IS NOT NULL
               AND w.repository_id = (SELECT repository_id FROM workspaces WHERE id = ?))
      )`)
      values.push(args.workspaceId, args.workspaceId)

      if (args.terms.length > 0) {
        where.push("search_document_fts MATCH ?")
        values.push(ftsQuery(args.terms))
      }
      if (args.filters.chatId && !args.filters.workspaceId) {
        where.push("(d.kind = 'work' OR d.ref = ?)")
        values.push(args.filters.chatId)
      }
      if (args.filters.status && args.filters.status.length > 0) {
        where.push("(d.kind != 'work' OR d.status IN (" + args.filters.status.map(() => "?").join(", ") + "))")
        values.push(...args.filters.status)
      } else if (!args.includeClosedWorkByDefault) {
        where.push("(d.kind != 'work' OR d.status IN ('open', 'active', 'blocked'))")
      }

      const rankExpr = args.terms.length > 0 ? "bm25(search_document_fts)" : "NULL"
      const query = `
        SELECT
          d.ref AS "ref",
          d.kind AS "kind",
          d.source_kind AS "sourceKind",
          d.chat_id AS "chatId",
          d.workspace_id AS "workspaceId",
          d.title AS "title",
          d.body AS "body",
          d.labels_json AS "labelsJson",
          d.status AS "status",
          d.created_at AS "createdAt",
          d.updated_at AS "updatedAt",
          ${rankExpr} AS "rank"
        FROM search_document d
        ${args.terms.length > 0 ? "JOIN search_document_fts ON search_document_fts.rowid = d.rowid" : ""}
        WHERE ${where.join(" AND ")}
      `
      return sql.unsafe<SearchDocumentRow>(query, values)
    }

    const searchMessageRefs = (chatId: string, terms: ReadonlyArray<string>) =>
      sql<{ ref: string }>`
        SELECT d.ref AS "ref"
        FROM search_document d
        JOIN search_document_fts ON search_document_fts.rowid = d.rowid
        WHERE d.kind = 'message'
          AND d.chat_id = ${chatId}
          AND search_document_fts MATCH ${ftsQuery(terms)}`

    const search = (params: ArcSearchParams) =>
      Effect.gen(function* () {
        const kinds = params.kinds && params.kinds.length > 0 ? params.kinds : (["work"] as const)
        const filters = params.filters ?? {}
        const terms = (params.query ?? "")
          .split(/\s+/)
          .filter((t) => t.length > 0)
          .map((t) => t.toLowerCase())
        const hasQuery = terms.length > 0
        const sort = params.sort ?? (hasQuery ? "relevance" : "updated")
        const limit = params.limit && params.limit > 0 ? params.limit : 20
        const offset = decodeCursor(params.cursor)

        // Each hit carries `createdAt` only to drive the `created` sort; it's
        // stripped before returning so the header stays rigid.
        const rows: Array<ArcSearchHit & { readonly createdAt: string }> = []

        const documentKinds = (["work", "chat"] as const).filter((kind) => kinds.includes(kind))
        if (documentKinds.length > 0 && (filters.workspaceId || filters.chatId)) {
          const workspaceId = filters.workspaceId ?? (yield* arc.workspaceIdForChat(filters.chatId!))
          if (!workspaceId) return { hits: [], total: 0, nextCursor: null }
          const docs = yield* searchDocuments({
            kinds: documentKinds,
            terms,
            filters,
            // Browse default: with no query and no explicit status, behave like
            // the open work queue (drop done/superseded). A query spans every
            // status so resolved work stays findable.
            includeClosedWorkByDefault: hasQuery,
            workspaceId,
          })
          const bestByRef = new Map<string, SearchDocumentRow>()
          for (const doc of docs) {
            if (doc.kind === "work" && !hasEveryLabel(doc.labelsJson, filters.labels ?? [])) continue
            const prior = bestByRef.get(doc.ref)
            if (!prior || (doc.rank ?? Number.POSITIVE_INFINITY) < (prior.rank ?? Number.POSITIVE_INFINITY)) {
              bestByRef.set(doc.ref, doc)
            }
          }
          for (const doc of bestByRef.values()) {
            rows.push({
              ref: doc.ref,
              kind: doc.kind,
              title: doc.title,
              preview: preview(doc.body.length > 0 ? doc.body : doc.title),
              updatedAt: doc.updatedAt,
              score: hasQuery ? -(doc.rank ?? 0) : null,
              createdAt: doc.createdAt,
            })
          }
        }

        // A `message` hit is one chat's timeline row (a message OR a tool call).
        // It's inherently chat-scoped: without `filters.chatId` there's nothing
        // to enumerate, so it contributes no hits. `ordinal` is stamped over the
        // full displayed timeline before any query filter, so it stays the row's
        // true render position regardless of what the query narrows to.
        if (kinds.includes("message") && filters.chatId) {
          const timeline = yield* chatMessages.listForChat(filters.chatId)
          const indexedMessageRefs =
            hasQuery ? new Set((yield* searchMessageRefs(filters.chatId, terms)).map((row) => row.ref)) : null
          timeline.forEach((m, ordinal) => {
            const meta = messageHitMeta(m, ordinal)
            const haystack = `${m.body}\n${meta.toolName ?? ""}`
            if (indexedMessageRefs) {
              if (indexedMessageRefs.size > 0) {
                if (!indexedMessageRefs.has(m.id)) return
              } else if (!terms.every((t) => haystack.toLowerCase().includes(t))) {
                // Test stubs and legacy rows with no projection still exercise
                // the old timeline contract; real persisted rows use FTS above.
                return
              }
            }
            rows.push({
              ref: m.id,
              kind: "message",
              title: meta.toolName ?? m.role,
              preview: preview(m.body.length > 0 ? m.body : (meta.toolName ?? m.role)),
              updatedAt: m.occurredAt,
              score: hasQuery ? scoreText(terms, haystack) : null,
              createdAt: m.occurredAt,
              message: meta,
            })
          })
        }

        // A pure message query is a timeline read: order by render position
        // (ordinal asc), not the relevance/recency order the entity kinds use.
        const messageOnly = kinds.length === 1 && kinds[0] === "message"
        const ordered = messageOnly
          ? rows.toSorted((a, b) => (a.message?.ordinal ?? 0) - (b.message?.ordinal ?? 0))
          : rows.toSorted((a, b) => {
          if (sort === "relevance") {
            const byScore = (b.score ?? 0) - (a.score ?? 0)
            if (byScore !== 0) return byScore
            return b.updatedAt.localeCompare(a.updatedAt)
          }
          if (sort === "created") return b.createdAt.localeCompare(a.createdAt)
          return b.updatedAt.localeCompare(a.updatedAt)
        })

        const total = ordered.length
        const hits = ordered
          .slice(offset, offset + limit)
          .map(({ createdAt: _createdAt, ...hit }) => hit)
        const nextCursor = offset + limit < total ? encodeCursor(offset + limit) : null
        return { hits, total, nextCursor }
      })

    const get = (params: ArcGetParams) =>
      Effect.gen(function* () {
        // Batch-first: merge the single-ref convenience into `refs`, dedup, and
        // keep first-seen order so the response mirrors the request.
        const requested = [...(params.ref ? [params.ref] : []), ...(params.refs ?? [])]
        const seen = new Set<string>()
        const refs = requested.filter((r) => (seen.has(r) ? false : (seen.add(r), true)))
        const include = params.include ?? (["comments"] as const)
        const wantComments = include.includes("comments")

        const entities: Array<ArcEntity> = []
        const notFound: Array<string> = []
        // Hydrate chats from the one in-memory snapshot, not per-ref.
        const chatList = refs.some((r) => r.startsWith("chat_")) ? yield* chats.list : []

        for (const ref of refs) {
          if (ref.startsWith("chat_")) {
            const chat = chatList.find((c) => c.id === ref)
            if (chat) entities.push({ _tag: "chat", chat })
            else notFound.push(ref)
            continue
          }
          if (isMessageRef(ref)) {
            const message = yield* chatMessages.getById(ref)
            if (message) entities.push({ _tag: "message", message })
            else notFound.push(ref)
            continue
          }
          if (isWorkRef(ref)) {
            const found = yield* work.get(ref)
            if (!found) {
              notFound.push(ref)
              continue
            }
            if (wantComments) {
              const listing = yield* work.listComments(found.id)
              entities.push({
                _tag: "work",
                work: found,
                comments: listing.comments,
                olderRevisionCommentCount: listing.olderRevisionCommentCount,
              })
            } else {
              entities.push({ _tag: "work", work: found, comments: [], olderRevisionCommentCount: 0 })
            }
            continue
          }
          // A kind arc.get can't hydrate yet (comment/session/…) — not an error.
          notFound.push(ref)
        }

        return { entities, notFound }
      })

    return { search, get } as const
  }),
)
