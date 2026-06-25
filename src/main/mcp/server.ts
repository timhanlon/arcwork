import { Effect, Layer, Schema } from "effect"
import * as McpServer from "effect/unstable/ai/McpServer"
import { nowIso } from "../clock.js"
import * as Tool from "effect/unstable/ai/Tool"
import * as Toolkit from "effect/unstable/ai/Toolkit"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  Citation,
  Work,
  WorkComment,
  WorkPriority,
  WorkStatus,
} from "../../shared/work.js"
import { Chat } from "../../shared/chat.js"
import { TargetSession } from "../../shared/instance.js"
import {
  ArcGetParams,
  ArcGetResult,
  ArcSearchParams,
  ArcSearchResult,
} from "../../shared/read.js"
import { arcId, ChatId, WorkId, WorkspaceId } from "../../shared/ids.js"
import { WorkService } from "../work/service.js"
import { TargetSessionManager } from "../services/TargetSessionManager.js"
import { ChatService } from "../services/ChatService.js"
import { arcRequestError } from "../errors.js"
import { ReadService } from "../read/service.js"
import { resolveArcDb } from "../db/paths.js"
import {
  ARC_MCP_PATH,
  arcMcpPort,
  arcMcpUrl,
  chooseMcpPort,
} from "./endpoint.js"
import { readMcpProvenanceHeaders, resolveMcpWriteProvenance } from "./provenance.js"

/**
 * The **Arc MCP server** — a narrow door for target CLIs onto arc's work graph.
 * It exposes four tools — `arc.search`, `arc.get`, `arc.work.create`,
 * `arc.work.update` — so an agent can discover, read, author, and mutate work
 * through MCP rather than shelling out.
 *
 * Topology: this runs *in-process*, inside the Arc Work main process, over a
 * loopback HTTP transport. The tools call the *same* live `WorkService`/`ReadService`
 * instances the UI uses (memoized by reference through `AppLive`), never a
 * parallel store. MCP is one transport; the domain verbs stay independent of it.
 *
 * Provenance: the shared HTTP server can't read the caller's `ARC_*` env, so write
 * tools accept optional `sessionId`/`chatId` params as a fallback. The primary
 * path is the `ARC_MCP_TOKEN` bearer (`sessionId:chatId`): the launched session's
 * config carries it and handlers prefer it over voluntary params.
 */

const ARC_MCP_NAME = "arc"
const ARC_MCP_VERSION = "0.1.0"
/** POST endpoint path; the discovery file records the full `http://127.0.0.1:<port>/mcp` URL.
 * The port/path constants live in `./endpoint.ts` so config generation agrees on them. */
const MCP_PATH = ARC_MCP_PATH

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

const PrimeResult = Schema.Struct({
  chat: Schema.optional(Chat),
  target: Schema.optional(TargetSession),
  assignedWork: Schema.Array(Work),
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
  parameters: Schema.Struct({
    title: Schema.String,
    body: Schema.optional(Schema.String),
    labels: Schema.optional(Schema.Array(Schema.String)),
    status: Schema.optional(WorkStatus),
    priority: Schema.optional(WorkPriority),
    citations: Schema.optional(Schema.Array(Citation)),
    sessionId: Schema.optional(Schema.String),
    chatId: Schema.optional(ChatId),
  }),
  success: Work,
})

const WorkUpdateTool = Tool.make("arc.work.update", {
  description:
    "Mutate an existing unit of work — the one write door for edits, status, priority, and comments. Supply at least one operation; bundle several in a single call and they apply in a deterministic order (content revision → status → priority → comment). `set.title`/`set.body`/`set.labels` revise authored content (a present field replaces, `labels` as a whole set; mints a new revision). `set.status` moves the work between any status, including the terminal `done`/`superseded` — status is an append-only edge, so this records a transition rather than overwriting. `set.priority` ranks the work (p0 highest). `addComment` attaches a comment (`ref: true` anchors it to the work as a whole rather than the current revision). Returns the work in its final state, plus the created comment when `addComment` was supplied. Arc derives workspace scope and the calling session's observed harness/model from the stamped MCP session/chat; `sessionId`/`chatId` params are fallback provenance only.",
  parameters: Schema.Struct({
    workRefId: WorkId,
    set: Schema.optional(
      Schema.Struct({
        title: Schema.optional(Schema.String),
        body: Schema.optional(Schema.String),
        labels: Schema.optional(Schema.Array(Schema.String)),
        status: Schema.optional(WorkStatus),
        priority: Schema.optional(WorkPriority),
      }),
    ),
    addComment: Schema.optional(
      Schema.Struct({
        body: Schema.String,
        ref: Schema.optional(Schema.Boolean),
      }),
    ),
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

const ArcToolkit = Toolkit.make(
  SearchTool,
  GetTool,
  WorkCreateTool,
  WorkUpdateTool,
  AgentSpawnTool,
  PrimeTool,
)

/**
 * Orchestration priming, pushed into the spawn prompt rather than pulled via a
 * SessionStart hook: prepend the assigned work to the caller's instructions so a
 * freshly launched agent starts already oriented on what it was delegated. The
 * prompt is delivered by each provider's normal injection (cursor stdin paste,
 * claude `--prefill`, …); `arc.prime` stays available for an already-running
 * agent to re-fetch the same context on demand.
 *
 * The wording is deliberately blunt and MCP-first: weaker models (e.g. Cursor's
 * Composer) otherwise grep the repo for `arc.prime`, or try to run it as a shell
 * command (`which arc; arc prime`), instead of invoking it as the MCP tool it is.
 */
const buildOrchestrationPrompt = (work: Work, instructions: string | undefined): string => {
  const header =
    "You are an agent spawned by Arc Work to carry out an assigned unit of work. " +
    "Arc gives you `arc.prime`, `arc.work.update`, `arc.get`, and `arc.search` as " +
    "MCP TOOLS in your available-tools list — already connected in this session. " +
    "They are NOT shell commands: there is no `arc` CLI, so never run `arc ...` in a " +
    "terminal, and never grep or list the repo to check whether they exist. Invoke " +
    "them directly as tool calls. If a call is rejected or errors, stop and report " +
    "the exact error; never conclude the tools are missing."
  const steps =
    "Do these in order:\n" +
    "1. Invoke the `arc.prime` tool FIRST to load your full assignment and context.\n" +
    "2. Carry out the work.\n" +
    "3. Invoke the `arc.work.update` tool as you go — comment on progress and " +
    "blockers, and set status to `done` only once the work is actually complete. " +
    "Reporting back via `arc.work.update` is part of finishing, not optional.\n" +
    "(The `arc.search` / `arc.get` tools read the work graph if you need more context.)"
  const assignment = `Assigned work ${work.id} [${work.priority}/${work.status}]: ${work.title}\n\n${work.body}`
  const task = instructions?.trim()
  return [header, steps, assignment, task ? `Task:\n${task}` : undefined].filter(Boolean).join("\n\n")
}

// ── Handlers ─────────────────────────────────────────────────────────────────
// Services are acquired once in the build effect and closed over; each handler
// `orDie`s its domain errors so the MCP layer reports them to the client as a
// tool error (Cause.pretty) without the handler's error channel leaking past the
// `Tool.Failure | AiError` contract.

const ArcToolkitLayer = ArcToolkit.toLayer(
  Effect.gen(function* () {
    const work = yield* WorkService
    const read = yield* ReadService
    const sessions = yield* TargetSessionManager
    const chats = yield* ChatService

    return {
      // A client can't know its own chatId — that's transport context — so
      // default the search scope from the session's provenance (x-arc-chat-id
      // header or the `sessionId:chatId` bearer), the same source the write
      // handlers use. An explicit `filters.chatId` still wins, so a caller can
      // read across into another chat's workspace. Without this the search is
      // unsatisfiable from the client side: `read.search` skips the work/chat
      // query unless `filters.chatId` is set, returning empty
      // (`work_01kvc4z3...`).
      "arc.search": (params) =>
        Effect.gen(function* () {
          const { chatId } = yield* readMcpProvenanceHeaders()
          const scoped =
            chatId && !params.filters?.chatId
              ? { ...params, filters: { ...params.filters, chatId: arcId("chat", chatId) } }
              : params
          return yield* read.search(scoped)
        }).pipe(Effect.orDie),

      "arc.get": (params) => read.get(params).pipe(Effect.orDie),

      "arc.work.create": (params) =>
        Effect.gen(function* () {
          const provenance = yield* resolveMcpWriteProvenance(params)
          return yield* work.create(
            {
              title: params.title,
              body: params.body ?? "",
              labels: params.labels,
              status: params.status,
              priority: params.priority,
              citations: params.citations,
            },
            provenance,
          )
        }).pipe(Effect.orDie),

      "arc.work.update": (params) =>
        Effect.gen(function* () {
          const provenance = yield* resolveMcpWriteProvenance(params)
          const set = params.set
          const addComment = params.addComment
          const willRevise =
            set?.title !== undefined || set?.body !== undefined || set?.labels !== undefined
          const willSetStatus = set?.status !== undefined
          const willSetPriority = set?.priority !== undefined
          const willComment = addComment !== undefined
          // At-least-one-operation can't be expressed in the JSON Schema, so guard
          // here; an empty update is a caller mistake, not a silent no-op.
          if (!willRevise && !willSetStatus && !willSetPriority && !willComment) {
            return yield* Effect.fail(
              arcRequestError(
                "arc.work.update requires at least one operation: set.title/body/labels, set.status, set.priority, or addComment",
              ),
            )
          }

          // Apply in a deterministic order so a bundled call is reproducible:
          // content revision, then status, then priority, then comment. Each
          // mutation returns the work's latest state; the last one is the final
          // payload (comment doesn't change the work, so it never overrides).
          let result: Work | undefined
          if (willRevise) {
            result = yield* work.revise(
              params.workRefId,
              { title: set!.title, body: set!.body, labels: set!.labels },
              provenance,
            )
          }
          if (willSetStatus) {
            result = yield* work.updateStatus(params.workRefId, set!.status!, provenance)
          }
          if (willSetPriority) {
            result = yield* work.updatePriority(params.workRefId, set!.priority!, provenance)
          }
          let comment: WorkComment | undefined
          if (addComment) {
            comment = yield* work.comment(
              params.workRefId,
              { body: addComment.body, ref: addComment.ref },
              provenance,
            )
          }
          // Comment-only calls never produced a `result`; load the current state.
          // The comment write already validated the ref exists, so a null here is
          // the unknown-work case (comment-only with a bad ref short-circuits above).
          if (!result) {
            const loaded = yield* work.get(params.workRefId)
            if (!loaded) {
              return yield* Effect.fail(arcRequestError(`unknown work: ${params.workRefId}`))
            }
            result = loaded
          }
          return { work: result, comment }
        }).pipe(Effect.orDie),

      "arc.agent.spawn": (params) =>
        Effect.gen(function* () {
          const { chatId: headerChatId } = yield* readMcpProvenanceHeaders()
          const chatId = params.chatId ?? (headerChatId ? arcId("chat", headerChatId) : undefined)
          if (!chatId) {
            return yield* Effect.fail(arcRequestError("arc.agent.spawn requires chatId or MCP chat provenance"))
          }
          // Resolve the assigned work first so its context can be pushed into the
          // launch prompt (priming), then minted into the spawned session below.
          const work0 = params.workRefId ? yield* work.get(params.workRefId) : null
          const prompt = work0 ? buildOrchestrationPrompt(work0, params.instructions) : params.instructions
          const session = yield* sessions.launch({
            provider: params.provider,
            chatId,
            workspaceId: params.workspaceId,
            preset: params.preset,
            prompt,
            autoSubmit: true,
            cols: params.cols,
            rows: params.rows,
            origin: "orchestrated",
            reuseExisting: false,
          })
          let assignedWork: Work | undefined
          if (params.workRefId) {
            const provenance = yield* resolveMcpWriteProvenance({ chatId, sessionId: session.id })
            assignedWork = yield* work.linkTargetSession(params.workRefId, session.id, provenance, "orchestrated spawn")
          }
          return { session, assignedWork }
        }).pipe(Effect.orDie),

      "arc.prime": (params) =>
        Effect.gen(function* () {
          const ids = yield* readMcpProvenanceHeaders()
          const sessionId = params.sessionId ?? ids.sessionId
          const chatId = params.chatId ?? (ids.chatId ? arcId("chat", ids.chatId) : undefined)
          const sessionList = yield* sessions.list
          const target = sessionId ? sessionList.find((s) => s.id === sessionId) : undefined
          const chatList = yield* chats.list
          const chat = (target?.chatId ?? chatId) ? chatList.find((c) => c.id === (target?.chatId ?? chatId)) : undefined
          const assignedWork = sessionId
            ? (yield* work.listDelegatedTo(arcId("target", sessionId))).map((d) => d.work)
            : []
          return { chat, target, assignedWork }
        }).pipe(Effect.orDie),
    }
  }),
)

// ── Discovery ────────────────────────────────────────────────────────────────

/** Where target CLIs / config generation learn the live endpoint. Sits next to
 * the profile's `arc.sqlite` so it tracks the same dev/stable profile. */
const endpointFilePath = (): string => path.join(path.dirname(resolveArcDb().dbPath), "arc-mcp.json")

const writeEndpointFile = (url: string) =>
  Effect.flatMap(nowIso, (startedAt) =>
    Effect.sync(() => {
      try {
        const file = endpointFilePath()
        fs.mkdirSync(path.dirname(file), { recursive: true })
        fs.writeFileSync(
          file,
          `${JSON.stringify({ url, path: MCP_PATH, pid: process.pid, startedAt }, null, 2)}\n`,
        )
      } catch {
        // best-effort: a missing discovery file only costs manual config, never boot.
      }
    }),
  )

/** After the HTTP server is listening, publish its actual URL (the port is
 * ephemeral by default) to the discovery file and the log. */
const announce = Layer.effectDiscard(
  Effect.gen(function* () {
    const server = yield* HttpServer.HttpServer
    const addr = server.address
    if (addr._tag !== "TcpAddress") return
    const url = arcMcpUrl(addr.port)
    yield* writeEndpointFile(url)
    yield* Effect.logInfo(`arc MCP server listening at ${url}`)
  }),
)

/** This profile's persistent MCP port (stable→7793, dev→7794). Resolved from the
 * same profile the discovery file and DB use, so a dev app never probes or binds
 * the stable app's port. */
const persistentPort = arcMcpPort(resolveArcDb().profile)

/** Can we bind this profile's persistent port on loopback right now? Probe with a
 * throwaway server so the decision (bind persistent / skip / ephemeral) is made
 * *before* the real bind, yielding a clean diagnostic instead of a raw EADDRINUSE. */
const persistentPortIsFree = Effect.callback<boolean>((resume) => {
  const probe = createNetServer()
  probe.once("error", () => {
    probe.close()
    resume(Effect.succeed(false))
  })
  probe.listen(persistentPort, "127.0.0.1", () => probe.close(() => resume(Effect.succeed(true))))
})

/** Resolve what the server should do: bind this profile's persistent port (the
 * default that keeps installed configs valid across restarts), bind an
 * explicit/ephemeral port when the user opts in, or skip — refusing to *silently*
 * bind an ephemeral port when the persistent one is taken, which would leave
 * installed configs pointed at a dead URL. The pure decision lives in
 * `./endpoint.ts`; here we feed it the probe result. */
const decidePort = Effect.map(persistentPortIsFree, (free) =>
  chooseMcpPort(
    {
      port: process.env["ARC_MCP_PORT"],
      allowEphemeral: process.env["ARC_MCP_ALLOW_EPHEMERAL"],
    },
    persistentPort,
    free,
  ),
)

// ── Served layer ─────────────────────────────────────────────────────────────
// Mirror the proven RpcServer-over-HTTP wiring (platform-node RpcServer.test):
// register the toolkit into an McpServer.layerHttp, pin one HttpRouter, then
// HttpRouter.serve it on a loopback NodeHttpServer.

/**
 * Make notification/response acks spec-compliant for MCP's Streamable HTTP
 * transport. Effect's RPC HTTP transport answers a JSON-RPC *notification* (no
 * `id` — e.g. `notifications/initialized`) with **200 + empty body**, but the
 * spec requires **202 Accepted with no body** for any notification/response.
 * Codex's RMCP client unconditionally JSON-parses the response body, so an empty
 * 200 yields `EOF while parsing` and the transport is torn down during startup
 * (openai/codex#20982; same class as java-sdk#586/#396, typescript-sdk#1994).
 *
 * This global middleware rewrites empty-body 200 → 202 at arc's HTTP layer, so we
 * own the fix in app code instead of patching Effect's `RpcServer` in
 * `node_modules` (which any reinstall wipes, and which is byte-identical from
 * beta.74 through beta.83 — a version bump does not help). Scoped to this router,
 * the only empty-body 200s are notification/response acks; real tool results
 * always carry a JSON body and pass through untouched (`work_01ktxk6mp1fvmrtndffwwc9d33`).
 */
const NotificationStatusFix = HttpRouter.middleware(
  (httpEffect) =>
    Effect.map(httpEffect, (response) =>
      // Only a genuinely empty body is a notification/response ack. Match `Empty`
      // or an explicit zero length — never `contentLength === undefined`, which is
      // a stream/form body (e.g. an SSE `text/event-stream` 200 for a request),
      // not an empty one.
      response.status === 200 &&
      (response.body._tag === "Empty" || response.body.contentLength === 0)
        ? HttpServerResponse.setStatus(response, 202)
        : response,
    ),
  { global: true },
)

const McpProtocol = Layer.effectDiscard(McpServer.registerToolkit(ArcToolkit)).pipe(
  Layer.provide(McpServer.layerHttp({ name: ARC_MCP_NAME, version: ARC_MCP_VERSION, path: MCP_PATH })),
  Layer.provide(NotificationStatusFix),
  Layer.provide(ArcToolkitLayer),
  Layer.provide(HttpRouter.layer),
)

/** Start the HTTP listener on `port` and publish the discovery file. */
const servedLayer = (port: number, ephemeral: boolean) =>
  Layer.mergeAll(
    HttpRouter.serve(McpProtocol, { disableListenLog: true }),
    announce,
    // When the user opts into an ephemeral port, say so loudly: installed client
    // configs pointed at the stable port will not connect this run.
    ephemeral
      ? Layer.effectDiscard(
          Effect.logWarning(
            "arc MCP bound an ephemeral port; installed client configs pointed at the stable port will not connect — re-run `arc-mcp` against this run's URL",
          ),
        )
      : Layer.empty,
  ).pipe(Layer.provide(NodeHttpServer.layer(() => createServer(), { host: "127.0.0.1", port })))

/**
 * The in-process Arc MCP HTTP server, ready to merge into the main runtime.
 * Requires the domain services its handlers use (satisfied by `AppLive`), so the
 * tools share the one live set of service instances with the UI.
 *
 * On a `Skip` decision (stable port busy, ephemeral not opted into) it does *not*
 * start a server: it logs the diagnostic loudly and leaves any existing discovery
 * file untouched (likely another arc instance is the one serving on the stable
 * port). The app boots regardless — MCP being unavailable must not brick the UI.
 */
export const ArcMcpServerLive = Layer.unwrap(
  Effect.map(decidePort, (decision) =>
    decision._tag === "Bind"
      ? servedLayer(decision.port, decision.ephemeral)
      : Layer.effectDiscard(Effect.logError(decision.reason)),
  ),
)
