/**
 * Chat-message dedup keys — the convergence seam between the two projection
 * paths.
 *
 * A chat row is projected twice: once from the live hook stream
 * (`hooks/chat-message.ts`) and once from the re-ingested transcript
 * (`services/ChatMessageService.ts`'s `projectArtifactSession`). The two paths
 * must produce a *byte-identical* `dedup_key` for the same semantic row, or the
 * upsert in `db/store.ts` either duplicates the row or collides two distinct
 * ones. That contract is this module: both paths import these functions, so the
 * key format is single-sourced rather than mirrored as two string literals kept
 * in sync by hand.
 *
 * Identity is always a *native* id (tool-use id, message uuid, …), which the
 * provider replays verbatim across `--resume`, so a re-ingested transcript
 * collapses onto the existing row instead of duplicating. The turn id is
 * deliberately excluded from every key: a hook-projected request carries a turn,
 * its artifact re-projection does not, and omitting it lets them converge. The
 * turn still lives in the `turn_id` column for permission-resolution.
 *
 * The role tokens below are persisted inside existing `dedup_key` values. Do not
 * rename them — a changed token stops new projections from matching rows already
 * on disk, reintroducing the duplicates this seam exists to prevent.
 */

const composeKey = (targetSessionId: string, role: string, id: string): string =>
  `${targetSessionId}:${role}:${id}`

/** User prompt. Identity is the message uuid — unique per submit (identical text included). */
export const userDedupKey = (targetSessionId: string, messageId: string): string =>
  composeKey(targetSessionId, "user", messageId)

/** Optimistic composer echo — reconciled onto {@link userDedupKey} when the transcript bubble lands. */
export const composerOptimisticUserKey = (targetSessionId: string, messageId: string): string =>
  composeKey(targetSessionId, "composer-user", messageId)

/** Subagent summary row (hook path). Identity is the subagent id. */
export const subagentDedupKey = (targetSessionId: string, subagentId: string): string =>
  composeKey(targetSessionId, "subagent", subagentId)

/**
 * Permission / question request. Identity is the native tool-use / request id,
 * replayed across `--resume`. Shared by both projection paths so a hook-projected
 * request and its turn-less artifact re-projection collapse onto one row.
 */
export const requestDedupKey = (targetSessionId: string, requestId: string): string =>
  composeKey(targetSessionId, "request", requestId)

/** Tool call (artifact path only — hooks project requests, not tool rows). */
export const toolDedupKey = (targetSessionId: string, toolId: string): string =>
  composeKey(targetSessionId, "tool", toolId)

/** Recap (Claude away_summary). Identity is the recap record's native uuid. */
export const recapDedupKey = (targetSessionId: string, recapId: string): string =>
  composeKey(targetSessionId, "recap", recapId)

/**
 * Programmatic / meta prompt (ScheduleWakeup, `/loop`, skill injections).
 * Distinct from the user key so the relabel-or-insert in `projectArtifactSession`
 * is idempotent across re-ingests.
 */
export const metaDedupKey = (targetSessionId: string, metaId: string): string =>
  composeKey(targetSessionId, "meta", metaId)

/**
 * Assistant text — artifact-owned (the live hook stream renders an ephemeral
 * StreamingMessage that is never stored). Identity is the record uuid.
 */
export const assistantDedupKey = (targetSessionId: string, messageId: string): string =>
  composeKey(targetSessionId, "assistant", messageId)
