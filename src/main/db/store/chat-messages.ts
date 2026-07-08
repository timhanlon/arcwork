import { Effect } from "effect"
import type { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { ChatMessageRow } from "../schema.js"
import type { ChatId, TargetId } from "../../../shared/ids.js"
import type { ChatMessageUpsertMode } from "../../hooks/chat-message.js"

/** The chat-message read/projection slice of {@link ArcStore} — the durable
 * mirror of the live transcript, plus the hook→chat-message dedup/reconcile/
 * repair subsystem that converges streamed bubbles, composer optimistic rows,
 * and re-ingested artifacts onto a single deduplicated row per message. */
export interface ChatMessageStore {
  readonly deleteRequestMessagesForChat: (chatId: string) => Effect.Effect<number, SqlError>
  readonly upsertChatMessage: (
    row: ChatMessageRow,
    mode: ChatMessageUpsertMode,
  ) => Effect.Effect<boolean, SqlError>
  readonly deleteChatMessageByDedupKey: (
    dedupKey: string,
  ) => Effect.Effect<boolean, SqlError>
  readonly reconcileComposerOptimisticUser: (
    row: ChatMessageRow,
  ) => Effect.Effect<boolean, SqlError>
  /** Relabel a hook-projected user row (a programmatic `isMeta` prompt the live
   * stream couldn't distinguish) as `meta`, re-keying it to the artifact's
   * stable meta dedup key. Scoped to the originating target session so an
   * identical body in a sibling target (same chat, different provider) is never
   * touched. Returns false when no matching hook user row exists. */
  readonly relabelHookUserAsMeta: (params: {
    readonly targetSessionId: string
    readonly body: string
    readonly dedupKey: string
    readonly messageId: string | null
  }) => Effect.Effect<boolean, SqlError>
  readonly loadChatMessagesForChat: (
    chatId: string,
  ) => Effect.Effect<ReadonlyArray<ChatMessageRow>, SqlError>
  /** A single chat-message row by id, or null when no such row exists. */
  readonly loadChatMessageById: (
    id: string,
  ) => Effect.Effect<ChatMessageRow | null, SqlError>
  /** target-originated request rows still awaiting the user, across all chats */
  readonly loadPendingRequests: Effect.Effect<
    ReadonlyArray<{
      readonly chatId: ChatId
      readonly targetSessionId: TargetId
      readonly requestJson: string | null
    }>,
    SqlError
  >
  /** Mark a target's still-pending request rows superseded (state in json +
   * status final, so they leave the pending query). Returns the row count. */
  readonly supersedePendingRequestsForTarget: (
    targetSessionId: string,
  ) => Effect.Effect<number, SqlError>
}

const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

const parseJsonRecord = (json: string | null): Record<string, unknown> | null => {
  if (!json) return null
  try {
    return record(JSON.parse(json))
  } catch {
    return null
  }
}

/** Real, user-driven resolutions. Terminal: once reached, a later "pending"
 * re-projection must not reopen the request. "superseded" is intentionally NOT
 * here — it is a soft give-up state that fresh authoritative data may revive. */
const RESOLVED_REQUEST_STATES = new Set(["answered", "dismissed", "approved", "denied", "failed"])

/**
 * Merge a request's lifecycle state across projections that now share one row
 * (hook + artifact converge on the same dedup key). A real resolution wins over
 * a later "pending" — an artifact that lacks tool output must not reopen an
 * answered/approved request. Anything else takes the newer state, so a
 * "superseded" row can be revived to pending (or carried to a resolution) by a
 * later authoritative re-projection.
 */
const mergedRequestState = (previous: unknown, next: unknown): unknown =>
  typeof previous === "string" &&
  next === "pending" &&
  RESOLVED_REQUEST_STATES.has(previous)
    ? previous
    : next

const mergeRequestJson = (previousJson: string | null, nextJson: string | null): string | null => {
  if (!nextJson) return null
  const previous = parseJsonRecord(previousJson)
  const next = parseJsonRecord(nextJson)
  if (!previous || !next || previous["kind"] !== next["kind"]) return nextJson

  const state = mergedRequestState(previous["state"], next["state"])

  if (next["kind"] === "question") {
    const nextQuestions = Array.isArray(next["questions"]) ? next["questions"] : []
    const previousQuestions = Array.isArray(previous["questions"]) ? previous["questions"] : []
    return JSON.stringify({
      ...previous,
      ...next,
      state,
      title: next["title"] ?? previous["title"],
      questions: nextQuestions.length > 0 ? nextQuestions : previousQuestions,
    })
  }

  if (next["kind"] === "permission") {
    return JSON.stringify({
      ...previous,
      ...next,
      state,
      toolName: next["toolName"] ?? previous["toolName"],
      args: next["args"] ?? previous["args"],
      suggestion: next["suggestion"] ?? previous["suggestion"],
    })
  }

  return nextJson
}

/**
 * A request row's `status` follows its merged lifecycle state: still pending →
 * "pending" (keeps it in loadPendingRequests / the sidebar flag), any resolved
 * or superseded state → "final". Non-request rows return null so the caller's
 * own status stands. This is what lets a supersede (status "final") be revived
 * to pending by a later authoritative re-projection: the row status follows the
 * merged state rather than fighting it.
 */
const requestRowStatus = (requestJson: string | null): "pending" | "final" | null => {
  const request = parseJsonRecord(requestJson)
  if (!request) return null
  const kind = request?.["kind"]
  if (kind !== "question" && kind !== "permission") return null
  const state = request["state"]
  if (typeof state !== "string") return null
  return state === "pending" ? "pending" : "final"
}

/** Build the chat-message read-model query closures over a SQL client. Composed
 * into {@link ArcStoreLive} alongside the git slice. */
export const makeChatMessageStore = (sql: SqlClient): ChatMessageStore => {
  // The chat_messages INSERT, spelled once. Every caller writes the same column
  // set from `row`; only the dedup key varies (a repair reconciles a streamed
  // bubble under a recomputed key), so it defaults to the row's own key.
  const insertChatMessageRow = (row: ChatMessageRow, dedupKey: string = row.dedupKey) =>
    sql`INSERT INTO chat_messages ${sql.insert({
      id: row.id,
      chatId: row.chatId,
      targetSessionId: row.targetSessionId,
      role: row.role,
      turnId: row.turnId,
      messageId: row.messageId,
      chunkIndex: row.chunkIndex,
      body: row.body,
      status: row.status,
      model: row.model,
      requestJson: row.requestJson,
      injectedFromTargetSessionId: row.injectedFromTargetSessionId,
      injectedTargetMessageId: row.injectedTargetMessageId,
      occurredAt: row.occurredAt,
      source: row.source,
      dedupKey,
    })}`

  const deleteRequestMessagesForChat = (chatId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM chat_messages
          WHERE chat_id = ${chatId}
            AND role = 'request'`
        const rows = yield* sql<{ changes: number }>`SELECT changes() AS changes`
        return rows[0]?.changes ?? 0
      }),
    )

  const repairAssistantTurnMessage = (row: ChatMessageRow, preferredMessageId: string | null) =>
    Effect.gen(function* () {
      const targetSessionId = row.targetSessionId
      const turnId = row.turnId
      if (!targetSessionId || !turnId) return false

      let repairKey: string | null = preferredMessageId
        ? `${targetSessionId}:${turnId}:${preferredMessageId}`
        : null

      if (!repairKey) {
        const candidates = yield* sql<{ dedupKey: string }>`
          SELECT dedup_key AS dedupKey FROM chat_messages
          WHERE target_session_id = ${targetSessionId}
            AND turn_id = ${turnId}
            AND role = 'assistant'
          ORDER BY chunk_index DESC, occurred_at DESC, id DESC
          LIMIT 1`
        repairKey = candidates[0]?.dedupKey ?? null
      }

      // The Stop event's turn id can diverge from the stream's (Claude sends
      // turn_id on MessageDisplay but not always on Stop), so the turn-scoped
      // lookup above can miss the streamed bubble. Fall back to the most
      // recent in-flight assistant row for the session — that is the message
      // this Stop finalizes — rather than inserting a second final row.
      if (!repairKey) {
        const live = yield* sql<{ dedupKey: string }>`
          SELECT dedup_key AS dedupKey FROM chat_messages
          WHERE target_session_id = ${targetSessionId}
            AND role = 'assistant'
          ORDER BY (status = 'streaming') DESC, occurred_at DESC, chunk_index DESC, id DESC
          LIMIT 1`
        repairKey = live[0]?.dedupKey ?? null
      }

      const finalKey = `${targetSessionId}:${turnId}:assistant-final`
      const keyToUse = repairKey ?? finalKey

      const existing = yield* sql<{ id: string }>`
        SELECT id FROM chat_messages WHERE dedup_key = ${keyToUse} LIMIT 1`

      if (existing.length > 0) {
        yield* sql`UPDATE chat_messages SET
          body = ${row.body},
          status = ${row.status},
          model = COALESCE(${row.model}, model),
          occurred_at = ${row.occurredAt},
          message_id = COALESCE(${row.messageId}, message_id)
          WHERE dedup_key = ${keyToUse}`
      } else {
        yield* insertChatMessageRow(row, keyToUse)
      }

      // Drop sibling assistant fragments for this turn, plus any still-streaming
      // bubble left behind when the Stop turn id diverged from the stream's.
      yield* sql`DELETE FROM chat_messages
        WHERE target_session_id = ${targetSessionId}
          AND role = 'assistant'
          AND dedup_key != ${keyToUse}
          AND (turn_id = ${turnId} OR status = 'streaming')`

      return true
    })

  const reconcileComposerOptimisticUser = (row: ChatMessageRow) =>
    Effect.gen(function* () {
      if (!row.targetSessionId) return false

      const optimistic = yield* sql<{ dedupKey: string }>`
        SELECT dedup_key AS dedupKey FROM chat_messages
        WHERE target_session_id = ${row.targetSessionId}
          AND role = 'user'
          AND source = 'composer'
          AND body = ${row.body}
        ORDER BY occurred_at DESC, id DESC
        LIMIT 1`
      const optimisticKey = optimistic[0]?.dedupKey
      if (!optimisticKey) return false

      const canonical = yield* sql<{ id: string }>`
        SELECT id FROM chat_messages WHERE dedup_key = ${row.dedupKey} LIMIT 1`
      if (canonical.length > 0) {
        yield* sql`DELETE FROM chat_messages WHERE dedup_key = ${optimisticKey}`
        yield* sql`DELETE FROM chat_messages
          WHERE target_session_id = ${row.targetSessionId}
            AND role = 'user'
            AND source = 'composer'
            AND body = ${row.body}`
        return false
      }

      yield* sql`UPDATE chat_messages SET
        dedup_key = ${row.dedupKey},
        turn_id = ${row.turnId},
        message_id = COALESCE(${row.messageId}, message_id),
        status = ${row.status},
        source = ${row.source},
        occurred_at = ${row.occurredAt}
        WHERE dedup_key = ${optimisticKey}`
      return true
    })

  const deleteChatMessageByDedupKey = (dedupKey: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`DELETE FROM chat_messages WHERE dedup_key = ${dedupKey}`
        const rows = yield* sql<{ changes: number }>`SELECT changes() AS changes`
        return (rows[0]?.changes ?? 0) > 0
      }),
    )

  const relabelHookUserAsMeta = (params: {
    readonly targetSessionId: string
    readonly body: string
    readonly dedupKey: string
    readonly messageId: string | null
  }) =>
    Effect.gen(function* () {
      // Already relabelled on a prior re-ingest — let the caller's keyed upsert
      // reconcile it instead of relabelling a second hook row.
      const existing = yield* sql<{ id: string }>`
        SELECT id FROM chat_messages WHERE dedup_key = ${params.dedupKey} LIMIT 1`
      if (existing.length > 0) return false

      // Match only a hook-submitted user row (key ends `:user`), not a composer
      // optimistic row (`:composer-user:…`) or an already-converged meta row —
      // and only within the originating target session, so a sibling provider's
      // identical-bodied prompt in the same chat is never relabelled.
      const hit = yield* sql<{ id: string }>`
        SELECT id FROM chat_messages
        WHERE target_session_id = ${params.targetSessionId}
          AND role = 'user'
          AND body = ${params.body}
          AND dedup_key LIKE '%:user'
        ORDER BY occurred_at, id
        LIMIT 1`
      if (hit.length === 0) return false

      yield* sql`UPDATE chat_messages SET
        role = 'meta',
        dedup_key = ${params.dedupKey},
        message_id = COALESCE(${params.messageId}, message_id)
        WHERE id = ${hit[0]!.id}`
      return true
    })

  // Symmetric counterpart to repairAssistantTurnMessage's session-wide
  // fallback. The Stop hook can finalize a turn *before* its MessageDisplay
  // stream is committed (cold start, first turn of a session): Stop finds no
  // streamed bubble to repair and inserts a standalone `:assistant-final` row,
  // then the stream lands afterward under its own `turn:message` key. repair_turn
  // only reconciles from the Stop side and has already run, so the two rows
  // coexist as a duplicate. Once the stream finalizes we hold the full body, so
  // drop the orphaned Stop placeholder it duplicates — matched on body so a
  // distinct turn's response is never touched.
  const absorbOrphanAssistantFinal = (
    targetSessionId: string,
    dedupKey: string,
    body: string,
  ) =>
    sql`DELETE FROM chat_messages
      WHERE target_session_id = ${targetSessionId}
        AND role = 'assistant'
        AND dedup_key LIKE '%:assistant-final'
        AND dedup_key != ${dedupKey}
        AND body = ${body}`.pipe(Effect.asVoid)

  const upsertChatMessage = (row: ChatMessageRow, mode: ChatMessageUpsertMode) =>
    Effect.gen(function* () {
      if (mode === "repair_turn") {
        return yield* repairAssistantTurnMessage(row, row.messageId)
      }

      const existing = yield* sql<{
        id: string
        body: string
        status: string
        requestJson: string | null
        model: string | null
        occurredAt: string
        chunkIndex: number | null
        messageId: string | null
        injectedFrom: string | null
        injectedTargetMessageId: string | null
      }>`
        SELECT id, body, status, request_json AS requestJson, model, occurred_at AS occurredAt,
          chunk_index AS chunkIndex, message_id AS messageId,
          injected_from_target_session_id AS injectedFrom,
          injected_target_message_id AS injectedTargetMessageId
        FROM chat_messages WHERE dedup_key = ${row.dedupKey} LIMIT 1`

      if (mode === "insert") {
        if (existing.length > 0) return false
        yield* insertChatMessageRow(row)
        return true
      }

      if (existing.length === 0) {
        yield* insertChatMessageRow(row)
        if (mode === "append" && row.role === "assistant" && row.status === "final" && row.targetSessionId) {
          yield* absorbOrphanAssistantFinal(row.targetSessionId, row.dedupKey, row.body)
        }
        return true
      }

      const previous = existing[0]!
      const body = mode === "append" ? `${previous.body}${row.body}` : row.body
      const requestJson = mergeRequestJson(previous.requestJson, row.requestJson)
      // A request row's status follows its merged lifecycle state, so a
      // resolution can't be reopened and a supersede can be revived; other
      // rows keep the caller's status.
      const status = requestRowStatus(requestJson) ?? row.status

      // The artifact path re-projects the whole session every watch/poll tick, so
      // most upserts rewrite a row to the values it already holds — and an
      // unchanged UPDATE still fires the search_document -> FTS5 trigger cascade.
      // Skip the write when nothing the UPDATE would set actually changes. For a
      // COALESCE column the write is a no-op when the incoming value is null (keeps
      // the existing) or already equal; occurred_at is only written by "replace".
      if (mode === "replace" || mode === "replace_keep_time") {
        const coalescedUnchanged = (next: string | number | null, prev: string | number | null) =>
          next == null || next === prev
        const unchanged =
          body === previous.body &&
          status === previous.status &&
          requestJson === previous.requestJson &&
          coalescedUnchanged(row.model, previous.model) &&
          coalescedUnchanged(row.chunkIndex, previous.chunkIndex) &&
          coalescedUnchanged(row.messageId, previous.messageId) &&
          coalescedUnchanged(row.injectedFromTargetSessionId, previous.injectedFrom) &&
          coalescedUnchanged(row.injectedTargetMessageId, previous.injectedTargetMessageId) &&
          (mode === "replace_keep_time" || row.occurredAt === previous.occurredAt)
        if (unchanged) return false
      }

      // Injected-message attribution is written here too, not just on insert: a
      // reprojection strips the marker from `body`, so the attribution must land
      // on the same pass or the row would render as a plain user turn. COALESCE
      // keeps an existing non-null value (the fields never change once set).
      if (mode === "replace_keep_time") {
        yield* sql`UPDATE chat_messages SET
          body = ${body},
          status = ${status},
          model = COALESCE(${row.model}, model),
          request_json = ${requestJson},
          injected_from_target_session_id = COALESCE(${row.injectedFromTargetSessionId}, injected_from_target_session_id),
          injected_target_message_id = COALESCE(${row.injectedTargetMessageId}, injected_target_message_id),
          chunk_index = COALESCE(${row.chunkIndex}, chunk_index),
          message_id = COALESCE(${row.messageId}, message_id)
          WHERE dedup_key = ${row.dedupKey}`
      } else {
        yield* sql`UPDATE chat_messages SET
          body = ${body},
          status = ${status},
          model = COALESCE(${row.model}, model),
          request_json = ${requestJson},
          injected_from_target_session_id = COALESCE(${row.injectedFromTargetSessionId}, injected_from_target_session_id),
          injected_target_message_id = COALESCE(${row.injectedTargetMessageId}, injected_target_message_id),
          occurred_at = ${row.occurredAt},
          chunk_index = COALESCE(${row.chunkIndex}, chunk_index),
          message_id = COALESCE(${row.messageId}, message_id)
          WHERE dedup_key = ${row.dedupKey}`
      }
      if (mode === "append" && row.role === "assistant" && status === "final" && row.targetSessionId) {
        yield* absorbOrphanAssistantFinal(row.targetSessionId, row.dedupKey, body)
      }
      return true
    })

  const loadChatMessagesForChat = (chatId: string) =>
    sql<ChatMessageRow>`SELECT * FROM chat_messages
      WHERE chat_id = ${chatId}
      ORDER BY occurred_at, chunk_index, id`

  const loadChatMessageById = (id: string) =>
    sql<ChatMessageRow>`SELECT * FROM chat_messages WHERE id = ${id} LIMIT 1`.pipe(
      Effect.map((rows) => rows[0] ?? null),
    )

  const loadPendingRequests = sql<{
    readonly chatId: ChatId
    readonly targetSessionId: TargetId
    readonly requestJson: string | null
  }>`SELECT chat_id AS "chatId", target_session_id AS "targetSessionId", request_json AS "requestJson"
      FROM chat_messages
      WHERE role = 'request' AND status = 'pending' AND target_session_id IS NOT NULL
        AND (request_json IS NULL OR json_extract(request_json, '$.kind') = 'question')
      ORDER BY occurred_at, id`

  // A detached target can no longer be awaiting an answer under arc, so its
  // still-pending requests are marked superseded: state moves inside the json
  // (leaving real resolutions untouched) and status goes 'final' so the row
  // drops out of loadPendingRequests and the sidebar flag. Legacy body-only
  // pending rows (null request_json) still clear via the status change.
  const supersedePendingRequestsForTarget = (targetSessionId: string) =>
    sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`UPDATE chat_messages
          SET status = 'final',
              request_json = CASE
                WHEN request_json IS NOT NULL
                THEN json_set(request_json, '$.state', 'superseded')
                ELSE request_json
              END
          WHERE target_session_id = ${targetSessionId}
            AND role = 'request'
            AND status = 'pending'`
        const rows = yield* sql<{ changes: number }>`SELECT changes() AS changes`
        return rows[0]?.changes ?? 0
      }),
    )

  return {
    deleteRequestMessagesForChat,
    upsertChatMessage,
    deleteChatMessageByDedupKey,
    reconcileComposerOptimisticUser,
    relabelHookUserAsMeta,
    loadChatMessagesForChat,
    loadChatMessageById,
    loadPendingRequests,
    supersedePendingRequestsForTarget,
  }
}
