import { Effect, Layer, Schema } from "effect"
import * as McpServer from "effect/unstable/ai/McpServer"
import { nowIso } from "../clock.js"
import * as HttpRouter from "effect/unstable/http/HttpRouter"
import * as HttpServer from "effect/unstable/http/HttpServer"
import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse"
import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer"
import { createServer } from "node:http"
import { createServer as createNetServer } from "node:net"
import * as fs from "node:fs"
import * as path from "node:path"
import { Citation, type Work, type WorkComment, WorkPriority, WorkStatus } from "../../shared/work.js"
import { TargetSession } from "../../shared/instance.js"
import {
  ArcGetParams,
  ArcGetResult,
  ArcSearchParams,
  ArcSearchResult,
} from "../../shared/read.js"
import { arcId, ChatId, TargetId, WorkId, WorkspaceId } from "../../shared/ids.js"
import { WorkService } from "../work/service.js"
import { TargetSessionManager } from "../services/TargetSessionManager.js"
import { TargetInboxService } from "../services/TargetInboxService.js"
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
import { ArcToolkit } from "./tools.js"
import { buildOrchestrationPrompt } from "./orchestration-prompt.js"

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
    const inbox = yield* TargetInboxService

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
          const { title, body, labels, status, priority } = params.set ?? {}
          const addComment = params.addComment
          const willRevise = title !== undefined || body !== undefined || labels !== undefined
          const willSetStatus = status !== undefined
          const willSetPriority = priority !== undefined
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
            result = yield* work.revise(params.workRefId, { title, body, labels }, provenance)
          }
          if (willSetStatus) {
            result = yield* work.updateStatus(params.workRefId, status, provenance)
          }
          if (willSetPriority) {
            result = yield* work.updatePriority(params.workRefId, priority, provenance)
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
          const { chatId: headerChatId, sessionId: parentTargetId } = yield* readMcpProvenanceHeaders()
          const headerChat = headerChatId ? arcId("chat", headerChatId) : undefined
          // Don't let a caller launch the session under one chat while the
          // work-link provenance is recorded under another: the session uses this
          // `chatId`, but `resolveMcpWriteProvenance` below prefers the trusted
          // header chat — so a mismatch would split the spawn across chats.
          if (params.chatId && headerChat && params.chatId !== headerChat) {
            return yield* Effect.fail(
              arcRequestError("arc.agent.spawn chatId does not match MCP chat provenance"),
            )
          }
          const chatId = headerChat ?? params.chatId
          if (!chatId) {
            return yield* Effect.fail(arcRequestError("arc.agent.spawn requires chatId or MCP chat provenance"))
          }
          // Resolve the assigned work first so its context can be pushed into the
          // launch prompt (priming), then minted into the spawned session below.
          const work0 = params.workRefId ? yield* work.get(params.workRefId) : null
          const prompt = work0
            ? buildOrchestrationPrompt(params.provider, work0, params.instructions, parentTargetId)
            : params.instructions
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
          // Trusted transport provenance wins over the voluntary params (which are
          // only a fallback for clients without stamped headers) — otherwise a
          // target could read another session's assignment by passing a different
          // id. Mirrors `resolveMcpWriteProvenance`'s header-first rule.
          const sessionId = ids.sessionId ?? params.sessionId
          const chatId = ids.chatId ? arcId("chat", ids.chatId) : params.chatId
          const sessionList = yield* sessions.list
          const target = sessionId ? sessionList.find((s) => s.id === sessionId) : undefined
          const chatList = yield* chats.list
          const chat = (target?.chatId ?? chatId) ? chatList.find((c) => c.id === (target?.chatId ?? chatId)) : undefined
          const assignedWork = sessionId
            ? (yield* work.listDelegatedTo(arcId("target", sessionId))).map((d) => d.work)
            : []
          // Project to the lean shape — only what a primed agent needs, never the
          // full objects' provenance/citations/transcript-path noise.
          return {
            chat: chat ? { id: chat.id, title: chat.title } : undefined,
            target: target ? { id: target.id, provider: target.provider, cwd: target.cwd } : undefined,
            assignedWork: assignedWork.map((w) => ({
              id: w.id,
              title: w.title,
              body: w.body,
              status: w.status,
              priority: w.priority,
            })),
          }
        }).pipe(Effect.orDie),

      "arc.agent.send": (params) =>
        Effect.gen(function* () {
          // Fail loud on an undeliverable target rather than silently queuing into
          // the void — the caller should know the agent isn't there to receive it.
          const sessionList = yield* sessions.list
          const target = sessionList.find((s) => s.id === params.targetSessionId)
          if (!target) {
            return yield* Effect.fail(arcRequestError(`unknown target session: ${params.targetSessionId}`))
          }
          // The message must be surface-able. A target is deliverable if it has a
          // live PTY now (`attached` — pasted when idle, or flushed on turn-close
          // when busy) OR a resume path (a bound native session — the controller
          // flushes the inbox on the resume binding). A detached/exited target with
          // neither could never surface the message, so fail rather than return a
          // misleading `{ queued: true }`.
          if (target.attached !== true && !target.nativeSessionId) {
            return yield* Effect.fail(
              arcRequestError(`target session is not deliverable (no live session or resume path): ${params.targetSessionId}`),
            )
          }
          yield* inbox.enqueue(params.targetSessionId, params.body, params.from)
          return { queued: true, targetSessionId: params.targetSessionId }
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
