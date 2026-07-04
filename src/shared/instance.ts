import { Schema } from "effect"
import { ChatId, RunId, TargetId } from "./ids.js"

/**
 * Layer 3 — Instance (the running/recorded thing). Arc-owned ids are TypeIDs:
 * `run_…` for batch runs and `target_…` for interactive target sessions.
 * Two sibling subtypes unify as "contributions" (aux_run | target_turn):
 *   - Run: a non-interactive batch execution (.aux/runs/<id>/)
 *   - TargetSession: an interactive PTY session surfaced through a chat. cwd is
 *     the worktree root — the binding that gives multiple instances clean,
 *     slug-isolated artifact namespaces.
 */

export const TargetState = Schema.Literals([
  "idle",
  "running",
  "waiting_for_input",
  "waiting_for_approval",
  "exited",
  "unknown",
])
export type TargetState = typeof TargetState.Type

export const TargetOrigin = Schema.Literals(["manual", "orchestrated"])
export type TargetOrigin = typeof TargetOrigin.Type

export const Run = Schema.Struct({
  _tag: Schema.Literal("Run"),
  id: RunId,
  provider: Schema.String,
  preset: Schema.optional(Schema.String),
  cwd: Schema.String,
  startedAt: Schema.String,
})
export type Run = typeof Run.Type

export const TargetSession = Schema.Struct({
  _tag: Schema.Literal("TargetSession"),
  id: TargetId,
  provider: Schema.String,
  origin: Schema.optional(TargetOrigin),
  /** the orchestrator that spawned this session (the `arc.agent.spawn` caller),
   * for an orchestrated launch — the durable back-channel link a child reads to
   * message its parent. Absent for manual/top-level sessions. */
  spawnedBy: Schema.optional(TargetId),
  preset: Schema.optional(Schema.String),
  chatId: ChatId, // the chat this session belongs to
  cwd: Schema.String, // worktree root — the instance binding
  /** discovered after launch via the SessionStart hook; Arc-owned session
   * metadata persisted to `.arc/state/` — valuable for resume, debugging, and
   * future provider-artifact import (not a required cross-DB join key) */
  nativeSessionId: Schema.optional(Schema.String),
  nativeTranscriptPath: Schema.optional(Schema.String),
  /** true only when this Electron process owns a live PTY handle for the session */
  attached: Schema.optional(Schema.Boolean),
  resumable: Schema.optional(Schema.Boolean),
  /** The live runtime backing this session right now — `rpc` (app-server, no
   * terminal) or `pty`/absent (terminal). Not persisted; it reflects which
   * manager currently owns the session, so the renderer can skip the terminal
   * surface for an rpc session. */
  runtime: Schema.optional(Schema.Literals(["pty", "rpc"])),
  state: TargetState,
  startedAt: Schema.String,
})
export type TargetSession = typeof TargetSession.Type

export const Instance = Schema.Union([Run, TargetSession])
export type Instance = typeof Instance.Type
