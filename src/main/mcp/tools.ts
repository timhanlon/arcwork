import { Schema } from "effect"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import {
  Work,
  WorkComment,
  WorkCommentInput,
  WorkCreateInput,
  WorkPriority,
  WorkReviseInput,
  WorkStatus,
} from "../../shared/work.js"
import { TargetSession } from "../../shared/instance.js"
import { ArcGetParams, ArcGetResult, ArcSearchParams, ArcSearchResult } from "../../shared/read.js"
import { ChatId, TargetId, WorkId, WorkspaceId } from "../../shared/ids.js"

// ── Tool result schemas ──────────────────────────────────────────────────────
// Reuse the shared `Work`/`WorkComment` contracts as success schemas (same shapes
// back every door). Lists/details wrap in an object so MCP `structuredContent`
// stays an object, not a bare array.

/** What `arc.work.update` returns: the work in its final state after the call's
 * operations, plus the comment it created when `addComment` was supplied (absent
 * otherwise). One payload regardless of how many operations the call bundled. */
const WorkUpdateResult = Schema.Struct({
  work: Work,
  comment: Schema.optional(WorkComment),
})

const AgentSpawnResult = Schema.Struct({
  session: TargetSession,
  assignedWork: Schema.optional(Work),
})

/** `arc.prime` is read by a freshly-spawned subagent to orient itself, so it
 * returns only what the agent needs — not the full Work/Chat/TargetSession
 * objects (provenance, citations, nodeId, transcript paths, timestamps …) that
 * would dump a wall of noise into its context. The assignment is the point: the
 * work's id (to update it), title, and body, plus its current status/priority. */
const PrimedWork = Schema.Struct({
  id: WorkId,
  title: Schema.String,
  body: Schema.String,
  status: WorkStatus,
  priority: Schema.NullOr(WorkPriority),
})

const PrimeResult = Schema.Struct({
  chat: Schema.optional(Schema.Struct({ id: ChatId, title: Schema.String })),
  target: Schema.optional(Schema.Struct({ id: TargetId, provider: Schema.String, cwd: Schema.String })),
  assignedWork: Schema.Array(PrimedWork),
})

// ── Tool definitions ─────────────────────────────────────────────────────────

const SearchTool = Tool.make("arc.search", {
  description:
    "Find Arc entities matching an intent or filter — the core discovery tool. Returns thin, uniform result headers (ref/kind/title/preview/updatedAt/score); decide from the preview, then hydrate with arc.get. `kinds` defaults to [\"work\"]; pass [\"work\",\"chat\"] to sweep both. Work/chat searches require `filters.chatId`; Arc derives that chat's workspace and never searches a profile-global work queue. `query` is free text (every term must match); `filters` narrows structurally (status/labels are work-only, chatId scopes work to that chat's workspace and selects the chat itself). `sort` defaults to relevance with a query, else updated. Page with `limit` + the opaque `cursor` from a prior result's `nextCursor`. Browsing without a query defaults to the chat workspace's open work queue (done/superseded hidden); a query spans every status in that workspace so resolved work stays findable. Pass kinds [\"message\"] with filters.chatId to read a chat's ordered timeline as thin rows (one per message or tool call, in render order): each hit carries a `message` block with role, rowKind (message/tool/request), toolName, status (pending/completed/errored/denied — pending answers \"is this tool call stuck?\"), ordinal, and occurredAt — no bodies or tool I/O. Then arc.get(message_…) hydrates a single row in full.",
  parameters: ArcSearchParams,
  success: ArcSearchResult,
})

const GetTool = Tool.make("arc.get", {
  description:
    "Hydrate Arc refs to their canonical full objects — the one read path for any ref arc.search returns. Batch-first: pass `refs` (or a single `ref`). Resolves work refs (work_…, with their comment thread unless `include` omits \"comments\"), chat refs (chat_…, a cheap header — read the timeline via arc.search kinds [\"message\"]), and chat-message refs (message_…, hydrating one timeline row in full: conversational text/thinking, or a tool call's name/input/output/state). Unknown or not-yet-supported refs come back in `notFound` rather than failing the batch, so one bad ref never sinks the rest.",
  parameters: ArcGetParams,
  success: ArcGetResult,
})

const WorkCreateTool = Tool.make("arc.work.create", {
  description:
    "Create a durable unit of work (proposal/plan/todo/bug/decision — all one primitive). Returns the created work with its id. Arc derives workspace scope and the calling session's observed harness/model from the stamped MCP session/chat; `sessionId`/`chatId` params are fallback provenance only.",
  // WorkCreateInput with `body` relaxed to optional (the handler defaults it to
  // "") plus the MCP-transport provenance fallbacks.
  parameters: WorkCreateInput.pipe(
    Schema.fieldsAssign({
      body: Schema.optional(Schema.String),
      sessionId: Schema.optional(Schema.String),
      chatId: Schema.optional(ChatId),
    }),
  ),
  success: Work,
})

const WorkUpdateTool = Tool.make("arc.work.update", {
  description:
    "Mutate an existing unit of work — the one write door for edits, status, priority, and comments. Supply at least one operation; bundle several in a single call and they apply in a deterministic order (content revision → status → priority → comment). `set.title`/`set.body`/`set.labels` revise authored content (a present field replaces, `labels` as a whole set; mints a new revision). `set.status` moves the work between any status, including the terminal `done`/`superseded` — status is an append-only edge, so this records a transition rather than overwriting. `set.priority` ranks the work (p0 highest). `addComment` attaches a comment (`ref: true` anchors it to the work as a whole rather than the current revision). Returns the work in its final state, plus the created comment when `addComment` was supplied. Arc derives workspace scope and the calling session's observed harness/model from the stamped MCP session/chat; `sessionId`/`chatId` params are fallback provenance only.",
  parameters: Schema.Struct({
    workRefId: WorkId,
    // Compose from the canonical authored shapes so a field added to revise /
    // comment surfaces on this door automatically: `set` extends WorkReviseInput
    // (title/body/labels) with the two workflow facts the update verb also
    // applies; `addComment` is WorkCommentInput verbatim.
    set: Schema.optional(
      WorkReviseInput.pipe(
        Schema.fieldsAssign({
          status: Schema.optional(WorkStatus),
          priority: Schema.optional(WorkPriority),
        }),
      ),
    ),
    addComment: Schema.optional(WorkCommentInput),
    sessionId: Schema.optional(Schema.String),
    chatId: Schema.optional(ChatId),
  }),
  success: WorkUpdateResult,
})

const AgentSpawnTool = Tool.make("arc.agent.spawn", {
  description:
    "Spawn a new provider-backed Arc target session for orchestration. The spawned agent is a normal PTY-backed target session visible in Arc Work; same-provider sessions in one chat are allowed. Pass `workRefId` to durably assign work to the new target session. By default this mints a fresh `target_…`; reuse requires an explicit future target-session operation, not this spawn tool.",
  parameters: Schema.Struct({
    provider: Schema.String,
    chatId: Schema.optional(ChatId),
    workspaceId: Schema.optional(WorkspaceId),
    workRefId: Schema.optional(WorkId),
    instructions: Schema.optional(Schema.String),
    preset: Schema.optional(Schema.String),
    cols: Schema.optional(Schema.Number),
    rows: Schema.optional(Schema.Number),
  }),
  success: AgentSpawnResult,
})

const PrimeTool = Tool.make("arc.prime", {
  description:
    "Return startup context for the current Arc-launched target session: the chat it belongs to, target session metadata, and work currently delegated to that target. This is read-only and derives target/chat from MCP transport provenance; `sessionId`/`chatId` are fallback params for clients without stamped headers.",
  parameters: Schema.Struct({
    sessionId: Schema.optional(Schema.String),
    chatId: Schema.optional(ChatId),
  }),
  success: PrimeResult,
})

const AgentSendResult = Schema.Struct({
  queued: Schema.Boolean,
  targetSessionId: TargetId,
})

const AgentSendTool = Tool.make("arc.agent.send", {
  description:
    "Send a message INTO a running orchestrated target session (a follow-up, a correction, a peer message). The message is queued on that target's inbox and delivered as its next turn when it is idle — pasted into its live session — or held until its current turn ends. Use this to talk to an agent you spawned with arc.agent.spawn, or to report back to the orchestrator that spawned you; `targetSessionId` is the recipient (the id spawn returned, or your orchestrator's id). Arc stamps the real sender from your session identity and attributes the delivered turn to you automatically — `from` is only an optional display label, not the identity.",
  parameters: Schema.Struct({
    targetSessionId: TargetId,
    body: Schema.String,
    from: Schema.optional(Schema.String),
  }),
  success: AgentSendResult,
})

/** The Arc MCP toolkit — the seven `arc.*` tools, bound to their handlers in
 * server.ts via `ArcToolkit.toLayer`. */
export const ArcToolkit = Toolkit.make(
  SearchTool,
  GetTool,
  WorkCreateTool,
  WorkUpdateTool,
  AgentSpawnTool,
  PrimeTool,
  AgentSendTool,
)
