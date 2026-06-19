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
 * The provider contract: discover and extract every native session for a
 * workspace in a **single parse pass**, returning database-shaped rows.
 *
 * This replaced an earlier list-then-extract-per-ref shape whose Claude
 * implementation re-parsed the *entire* project directory once per session — an
 * O(sessions × transcript) blow-up that pegged the main process on every turn.
 * `collect` parses the workspace's transcripts exactly once; callers that only
 * want one session filter the result by `rows.session.nativeSessionId`.
 *
 * `nativeSessionId` is an optional hint: when set, a provider that can locate a
 * single session without parsing the rest SHOULD parse only that one and return
 * it. Claude (one self-contained `<sessionId>.jsonl` per session) and cursor
 * (each session keyed to its own `store.db`) both can. Providers that can't may
 * ignore it — callers still filter the result by `rows.session.nativeSessionId`,
 * so the hint is a cost optimization, never a correctness requirement. It is
 * load-bearing on the hot path: the transcript watcher re-ingests on every turn,
 * and without the hint claude re-parses the entire project dir (hundreds of MB)
 * each time, pegging the main process even though only one file changed.
 *
 * Implementations are built by a factory Effect that captures platform services
 * (FileSystem/Path) once, so this method carries no requirements (`R = never`).
 */
export interface AgentProvider {
  readonly id: ProviderId
  readonly collect: (
    workspace: string,
    nativeSessionId?: string,
  ) => Effect.Effect<ReadonlyArray<ExtractedRows>, IngestError>
}
