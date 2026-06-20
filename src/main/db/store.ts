import { Context, Effect, Layer } from "effect"
import { SqlClient } from "effect/unstable/sql/SqlClient"
import type { SqlError } from "effect/unstable/sql/SqlError"
import {
  arcMigrations,
  type ActivityEventRow,
  type ChatMessageRow,
  type ChatRow,
  type RawHookSignalRow,
  type TargetSessionRow,
  type WorkspaceRow,
} from "./schema.js"
import { runMigrations } from "./migrator.js"
import type { ChatMessageUpsertMode } from "../hooks/chat-message.js"

/**
 * Durable persistence for arc's own domain. The in-memory `SubscriptionRef`s in
 * `ChatService`/`TargetSessionManager` stay the source of truth for the *live*
 * surface; this store is their durable mirror, loaded back on boot so a relaunch
 * restores workspaces, chats, sessions, and the native-session binding.
 *
 * Reuses arc-ingest's `@effect/sql-sqlite-node` setup, with the schema applied
 * by the versioned `arc_migrations` ledger (see db/migrator.ts). WAL is enabled
 * for crash-resilience (and so a future read-only observer can attach without
 * blocking writes).
 */
export class ArcStore extends Context.Service<
  ArcStore,
  {
    readonly loadWorkspaces: Effect.Effect<ReadonlyArray<WorkspaceRow>, SqlError>
    readonly upsertWorkspace: (row: WorkspaceRow) => Effect.Effect<WorkspaceRow, SqlError>
    readonly workspaceExists: (id: string) => Effect.Effect<boolean, SqlError>
    readonly loadChats: Effect.Effect<ReadonlyArray<ChatRow>, SqlError>
    readonly insertChat: (chat: ChatRow) => Effect.Effect<void, SqlError>
    readonly updateChatTitle: (chatId: string, title: string) => Effect.Effect<boolean, SqlError>
    readonly workspacePathForChat: (chatId: string) => Effect.Effect<string | null, SqlError>
    readonly workspaceIdForChat: (chatId: string) => Effect.Effect<string | null, SqlError>
    readonly workspaceIdForTargetSession: (
      targetSessionId: string,
    ) => Effect.Effect<string | null, SqlError>
    readonly loadTargetSessions: Effect.Effect<ReadonlyArray<TargetSessionRow>, SqlError>
    readonly upsertTargetSession: (s: TargetSessionRow) => Effect.Effect<void, SqlError>
    readonly setNativeSessionId: (
      id: string,
      nativeSessionId: string,
      nativeTranscriptPath?: string | null,
    ) => Effect.Effect<void, SqlError>
    readonly setTargetSessionState: (id: string, state: string) => Effect.Effect<void, SqlError>
    readonly insertActivityEvent: (row: ActivityEventRow) => Effect.Effect<boolean, SqlError>
    readonly loadActivityEvents: (
      targetSessionId: string,
    ) => Effect.Effect<ReadonlyArray<ActivityEventRow>, SqlError>
    readonly loadActivityEventsForChat: (
      chatId: string,
    ) => Effect.Effect<ReadonlyArray<ActivityEventRow>, SqlError>
    /** Activity events that name a unit of work in their payload (`workRefId`),
     * oldest first — the durable handoff create/report trail for one work. */
    readonly loadActivityEventsForWork: (
      workRefId: string,
    ) => Effect.Effect<ReadonlyArray<ActivityEventRow>, SqlError>
    readonly chatIdForTargetSession: (
      targetSessionId: string,
    ) => Effect.Effect<string | null, SqlError>
    /** The harness/provider a target session runs (its `target_sessions.provider`),
     * or null when the session is unknown. The stable, Arc-owned half of execution
     * provenance — set at launch, never mutated. */
    readonly providerForTargetSession: (
      targetSessionId: string,
    ) => Effect.Effect<string | null, SqlError>
    /** The latest model observed on a target session's transcript/hook stream — the
     * most recent non-null `chat_messages.model` for that session, newest first.
     * The *mutable* half of execution provenance: a session can switch models
     * mid-run, so this reflects the current observed model, not the launch default.
     * Null when the session is unknown or no model has been observed yet. */
    readonly latestModelForTargetSession: (
      targetSessionId: string,
    ) => Effect.Effect<string | null, SqlError>
    readonly targetSessionForNative: (
      provider: string,
      nativeSessionId: string,
    ) => Effect.Effect<{ readonly id: string; readonly chatId: string } | null, SqlError>
    readonly targetSessionsForChat: (
      chatId: string,
    ) => Effect.Effect<ReadonlyArray<TargetSessionRow>, SqlError>
    readonly deleteRequestMessagesForChat: (chatId: string) => Effect.Effect<number, SqlError>
    readonly upsertChatMessage: (
      row: ChatMessageRow,
      mode: ChatMessageUpsertMode,
    ) => Effect.Effect<boolean, SqlError>
    readonly reconcileComposerOptimisticUser: (
      row: ChatMessageRow,
    ) => Effect.Effect<boolean, SqlError>
    readonly deleteChatMessageByDedupKey: (
      dedupKey: string,
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
        readonly chatId: string
        readonly targetSessionId: string
        readonly requestJson: string | null
      }>,
      SqlError
    >
    /** Mark a target's still-pending request rows superseded (state in json +
     * status final, so they leave the pending query). Returns the row count. */
    readonly supersedePendingRequestsForTarget: (
      targetSessionId: string,
    ) => Effect.Effect<number, SqlError>
    readonly insertRawHookSignal: (row: RawHookSignalRow) => Effect.Effect<boolean, SqlError>
    readonly loadRawHookSignalsForTarget: (
      targetSessionId: string,
    ) => Effect.Effect<ReadonlyArray<RawHookSignalRow>, SqlError>
  }
>()("arcwork/ArcStore") {}

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

export const ArcStoreLive = Layer.effect(
  ArcStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient

    // Concurrent-safe journaling + referential actions (connection settings, so
    // they run before the migrator, not as schema). A busy timeout lets a write
    // wait out a lock held by a concurrent connection instead of erroring with
    // SQLITE_BUSY.
    yield* sql`PRAGMA journal_mode = WAL`
    yield* sql`PRAGMA busy_timeout = 5000`
    yield* sql`PRAGMA foreign_keys = ON`
    yield* runMigrations("arc_migrations", arcMigrations)

    const loadWorkspaces =
      sql<WorkspaceRow>`SELECT * FROM workspaces ORDER BY last_opened_at DESC, name, id`

    const upsertWorkspace = (row: WorkspaceRow) =>
      Effect.gen(function* () {
        yield* sql`INSERT INTO workspaces ${sql.insert({
          id: row.id,
          path: row.path,
          name: row.name,
          createdAt: row.createdAt,
          lastOpenedAt: row.lastOpenedAt,
        })} ON CONFLICT(path) DO UPDATE SET
          last_opened_at = excluded.last_opened_at`
        const rows = yield* sql<WorkspaceRow>`SELECT * FROM workspaces WHERE path = ${row.path} LIMIT 1`
        const canonical = rows[0]
        if (!canonical) {
          return yield* Effect.die(new Error(`workspace upsert left no row for ${row.path}`))
        }
        return canonical
      })

    const workspaceExists = (id: string) =>
      sql<{ id: string }>`SELECT id FROM workspaces WHERE id = ${id} LIMIT 1`.pipe(
        Effect.map((rows) => rows.length > 0),
      )

    const loadChats = sql<ChatRow>`SELECT * FROM chats ORDER BY created_at, id`

    const insertChat = (chat: ChatRow) =>
      sql`INSERT INTO chats ${sql.insert({
        id: chat.id,
        workspaceId: chat.workspaceId,
        title: chat.title,
        createdAt: chat.createdAt,
      })} ON CONFLICT(id) DO UPDATE SET title = excluded.title`.pipe(Effect.asVoid)

    const updateChatTitle = (chatId: string, title: string) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`UPDATE chats SET title = ${title} WHERE id = ${chatId}`
          const rows = yield* sql<{ changes: number }>`SELECT changes() AS changes`
          return (rows[0]?.changes ?? 0) > 0
        }),
      )

    const workspacePathForChat = (chatId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ path: string }>`
          SELECT workspaces.path AS path FROM chats
          JOIN workspaces ON workspaces.id = chats.workspace_id
          WHERE chats.id = ${chatId}
          LIMIT 1`
        return rows[0]?.path ?? null
      })

    const workspaceIdForChat = (chatId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ workspaceId: string }>`
          SELECT workspace_id AS "workspaceId" FROM chats
          WHERE id = ${chatId}
          LIMIT 1`
        return rows[0]?.workspaceId ?? null
      })

    const workspaceIdForTargetSession = (targetSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ workspaceId: string }>`
          SELECT chats.workspace_id AS "workspaceId" FROM target_sessions
          JOIN chats ON chats.id = target_sessions.chat_id
          WHERE target_sessions.id = ${targetSessionId}
          LIMIT 1`
        return rows[0]?.workspaceId ?? null
      })

    const loadTargetSessions =
      sql<TargetSessionRow>`SELECT * FROM target_sessions ORDER BY started_at, id`

    const upsertTargetSession = (s: TargetSessionRow) =>
      sql`INSERT INTO target_sessions ${sql.insert({
        id: s.id,
        chatId: s.chatId,
        provider: s.provider,
        preset: s.preset,
        cwd: s.cwd,
        nativeSessionId: s.nativeSessionId,
        nativeTranscriptPath: s.nativeTranscriptPath,
        state: s.state,
        startedAt: s.startedAt,
      })} ON CONFLICT(id) DO UPDATE SET
        preset = excluded.preset,
        cwd = excluded.cwd,
        native_session_id = excluded.native_session_id,
        native_transcript_path = excluded.native_transcript_path,
        state = excluded.state,
        started_at = excluded.started_at`.pipe(Effect.asVoid)

    const setNativeSessionId = (
      id: string,
      nativeSessionId: string,
      nativeTranscriptPath?: string | null,
    ) =>
      sql`UPDATE target_sessions SET
        native_session_id = ${nativeSessionId},
        native_transcript_path = COALESCE(${nativeTranscriptPath ?? null}, native_transcript_path)
        WHERE id = ${id}`.pipe(Effect.asVoid)

    const setTargetSessionState = (id: string, state: string) =>
      sql`UPDATE target_sessions SET state = ${state} WHERE id = ${id}`.pipe(Effect.asVoid)

    const insertActivityEvent = (row: ActivityEventRow) =>
      Effect.gen(function* () {
        if (row.dedupKey) {
          const existing = yield* sql<{ dedupKey: string }>`
            SELECT dedup_key AS dedupKey FROM activity_events WHERE dedup_key = ${row.dedupKey} LIMIT 1`
          if (existing.length > 0) return false
        }
        yield* sql`INSERT INTO activity_events ${sql.insert({
          id: row.id,
          workspaceRoot: row.workspaceRoot,
          workContextId: row.workContextId,
          userActionId: row.userActionId,
          targetSessionId: row.targetSessionId,
          source: row.source,
          kind: row.kind,
          actor: row.actor,
          occurredAt: row.occurredAt,
          payloadJson: row.payloadJson,
          provenanceJson: row.provenanceJson,
          dedupKey: row.dedupKey,
        })}`
        return true
      })

    const loadActivityEvents = (targetSessionId: string) =>
      sql<ActivityEventRow>`SELECT * FROM activity_events
        WHERE target_session_id = ${targetSessionId}
        ORDER BY occurred_at, id`

    const loadActivityEventsForChat = (chatId: string) =>
      sql<ActivityEventRow>`SELECT * FROM activity_events
        WHERE work_context_id = ${chatId}
           OR target_session_id IN (
             SELECT id FROM target_sessions WHERE chat_id = ${chatId}
           )
        ORDER BY occurred_at, id`

    // Events that name a unit of work in their payload — handoff create/report,
    // which stamp `payload.workRefId`. The monitoring read model uses this to read
    // the latest structured report state per work without scanning comment prose.
    const loadActivityEventsForWork = (workRefId: string) =>
      sql<ActivityEventRow>`SELECT * FROM activity_events
        WHERE json_extract(payload_json, '$.workRefId') = ${workRefId}
        ORDER BY occurred_at, id`

    const chatIdForTargetSession = (targetSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ chatId: string }>`
          SELECT chat_id AS chatId FROM target_sessions WHERE id = ${targetSessionId} LIMIT 1`
        return rows[0]?.chatId ?? null
      })

    const providerForTargetSession = (targetSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ provider: string }>`
          SELECT provider FROM target_sessions WHERE id = ${targetSessionId} LIMIT 1`
        return rows[0]?.provider ?? null
      })

    // Latest observed model for the session: the newest chat-message row that
    // carries one. Ordered by occurred_at then id so a tie breaks deterministically
    // on the monotonic TypeID, matching every other "latest row" read here.
    const latestModelForTargetSession = (targetSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ model: string }>`
          SELECT model FROM chat_messages
          WHERE target_session_id = ${targetSessionId} AND model IS NOT NULL
          ORDER BY occurred_at DESC, id DESC
          LIMIT 1`
        return rows[0]?.model ?? null
      })

    const targetSessionForNative = (provider: string, nativeSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string; chatId: string }>`
          SELECT id, chat_id AS chatId FROM target_sessions
          WHERE provider = ${provider}
            AND native_session_id = ${nativeSessionId}
          LIMIT 1`
        if (rows[0]) return rows[0]

        const unbound = yield* sql<{ id: string; chatId: string }>`
          SELECT id, chat_id AS chatId FROM target_sessions
          WHERE provider = ${provider}
            AND native_session_id IS NULL
            AND state != 'exited'
          ORDER BY started_at DESC, id DESC
          LIMIT 2`
        return unbound.length === 1 ? unbound[0]! : null
      })

    const targetSessionsForChat = (chatId: string) =>
      sql<TargetSessionRow>`SELECT * FROM target_sessions
        WHERE chat_id = ${chatId}
        ORDER BY started_at, id`

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
          yield* sql`INSERT INTO chat_messages ${sql.insert({
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
            occurredAt: row.occurredAt,
            source: row.source,
            dedupKey: keyToUse,
          })}`
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

        const existing = yield* sql<{ id: string; body: string; requestJson: string | null }>`
          SELECT id, body, request_json AS requestJson FROM chat_messages WHERE dedup_key = ${row.dedupKey} LIMIT 1`

        if (mode === "insert") {
          if (existing.length > 0) return false
          yield* sql`INSERT INTO chat_messages ${sql.insert({
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
            occurredAt: row.occurredAt,
            source: row.source,
            dedupKey: row.dedupKey,
          })}`
          return true
        }

        if (existing.length === 0) {
          yield* sql`INSERT INTO chat_messages ${sql.insert({
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
            occurredAt: row.occurredAt,
            source: row.source,
            dedupKey: row.dedupKey,
          })}`
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
        if (mode === "replace_keep_time") {
          yield* sql`UPDATE chat_messages SET
            body = ${body},
            status = ${status},
            model = COALESCE(${row.model}, model),
            request_json = ${requestJson},
            chunk_index = COALESCE(${row.chunkIndex}, chunk_index),
            message_id = COALESCE(${row.messageId}, message_id)
            WHERE dedup_key = ${row.dedupKey}`
        } else {
          yield* sql`UPDATE chat_messages SET
            body = ${body},
            status = ${status},
            model = COALESCE(${row.model}, model),
            request_json = ${requestJson},
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
      readonly chatId: string
      readonly targetSessionId: string
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

    const insertRawHookSignal = (row: RawHookSignalRow) =>
      Effect.gen(function* () {
        const inserted = yield* sql<{ id: string }>`
          INSERT INTO raw_hook_signals ${sql.insert({
            id: row.id,
            chatId: row.chatId,
            targetSessionId: row.targetSessionId,
            targetProvider: row.targetProvider,
            resolvedProvider: row.resolvedProvider,
            declaredProvider: row.declaredProvider,
            declaredEvent: row.declaredEvent,
            nativeSessionId: row.nativeSessionId,
            nativeConversationId: row.nativeConversationId,
            nativeTurnId: row.nativeTurnId,
            nativeToolUseId: row.nativeToolUseId,
            nativeHookEventName: row.nativeHookEventName,
            hookInputSha256: row.hookInputSha256,
            hookInputParseOk: row.hookInputParseOk,
            observedAt: row.observedAt,
            receivedAt: row.receivedAt,
            payloadJson: row.payloadJson,
          })}
          ON CONFLICT DO NOTHING
          RETURNING id`
        return inserted.length > 0
      })

    const loadRawHookSignalsForTarget = (targetSessionId: string) =>
      sql<RawHookSignalRow>`SELECT * FROM raw_hook_signals
        WHERE target_session_id = ${targetSessionId}
        ORDER BY observed_at, id`

    return {
      loadWorkspaces,
      upsertWorkspace,
      workspaceExists,
      loadChats,
      insertChat,
      updateChatTitle,
      workspacePathForChat,
      workspaceIdForChat,
      workspaceIdForTargetSession,
      loadTargetSessions,
      upsertTargetSession,
      setNativeSessionId,
      setTargetSessionState,
      insertActivityEvent,
      loadActivityEvents,
      loadActivityEventsForChat,
      loadActivityEventsForWork,
      chatIdForTargetSession,
      providerForTargetSession,
      latestModelForTargetSession,
      targetSessionForNative,
      targetSessionsForChat,
      deleteRequestMessagesForChat,
      upsertChatMessage,
      deleteChatMessageByDedupKey,
      reconcileComposerOptimisticUser,
      relabelHookUserAsMeta,
      loadChatMessagesForChat,
      loadChatMessageById,
      loadPendingRequests,
      supersedePendingRequestsForTarget,
      insertRawHookSignal,
      loadRawHookSignalsForTarget,
    } as const
  }),
)
