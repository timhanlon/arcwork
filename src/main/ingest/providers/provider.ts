import type { Effect } from "effect"
import type { ExtractedRows, Provider as ProviderId } from "../db/schema.js"
import type { IngestError } from "../errors.js"

/** A native session discovered for a workspace, before full extraction. */
export interface NativeSessionRef {
  readonly nativeSessionId: string
  /** The file (Claude/Codex JSONL) or directory (Cursor session dir) backing this session. */
  readonly sourcePath: string
  readonly createdAt?: string
  readonly title?: string
}

/**
 * What a caller already knows about the session it wants collected.
 *
 * `nativeSessionId` is a **cost** hint: when set, a provider that can locate a
 * single session without parsing the rest SHOULD parse only that one. Claude
 * (one self-contained `<sessionId>.jsonl` per session) and cursor (each session
 * keyed to its own `store.db`) both can. Providers that can't may ignore it —
 * callers still filter the result by `rows.session.nativeSessionId`, so it is
 * never a correctness requirement. It is load-bearing on the hot path: the
 * transcript watcher re-ingests on every turn, and without it claude re-parses
 * the entire project dir (hundreds of MB) each time, pegging the main process
 * even though only one file changed.
 *
 * `transcriptPath` is a **correctness** hint: the provider-native file backing
 * that session, which arc already holds verbatim on the target session and in
 * every hook envelope. A provider that can read it directly MUST prefer it over
 * re-deriving a location from `workspace`, because the two disagree whenever the
 * agent's cwd stops matching where its transcript actually lives — claude
 * relocating into a worktree, or simply working from a subdirectory, both leave
 * the derived path pointing at a directory that does not hold the session. That
 * mismatch is silent: discovery finds nothing, ingest reports zero sessions, and
 * the chat's transcript just stops updating while hooks keep flowing. Fall back
 * to `workspace` discovery when the path is absent or gone from disk (a resume
 * mints a new file), so a stale hint degrades rather than blocks.
 */
export interface CollectHint {
  readonly nativeSessionId?: string
  readonly transcriptPath?: string
}

/**
 * The provider contract: discover and extract every native session for a
 * workspace in a **single parse pass**, returning database-shaped rows.
 *
 * This replaced an earlier list-then-extract-per-ref shape whose Claude
 * implementation re-parsed the *entire* project directory once per session — an
 * O(sessions × transcript) blow-up that pegged the main process on every turn.
 * `collect` parses the workspace's transcripts exactly once; callers that only
 * want one session filter the result by `rows.session.nativeSessionId`.
 *
 * Implementations are built by a factory Effect that captures platform services
 * (FileSystem/Path) once, so this method carries no requirements (`R = never`).
 */
export interface AgentProvider {
  readonly id: ProviderId
  readonly collect: (
    workspace: string,
    hint?: CollectHint,
  ) => Effect.Effect<ReadonlyArray<ExtractedRows>, IngestError>
}
