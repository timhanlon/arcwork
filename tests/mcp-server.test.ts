import { Effect, Layer, ManagedRuntime } from "effect"
import { mkdtempSync, readFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { ArcMcpServerLive } from "../src/main/mcp/server.js"
import { WorkService, WorkServiceLive } from "../src/main/work/service.js"
import { WorkStoreLive } from "../src/main/work/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { ReadService } from "../src/main/read/service.js"
import { ChatService } from "../src/main/services/ChatService.js"
import { TargetSessionManager } from "../src/main/services/TargetSessionManager.js"
import { TargetInboxService } from "../src/main/services/TargetInboxService.js"
import { WORK_STATUSES } from "../src/shared/work.js"

/**
 * Boots the in-process Arc MCP HTTP server and drives a real MCP handshake
 * against its loopback endpoint, asserting the toolkit is mounted and served.
 * This is the runtime check the typecheck can't give: that `McpServer.layerHttp`
 * + `HttpRouter.serve` + `NodeHttpServer` actually compose, listen, write the
 * discovery file, and answer `tools/list` with our tools.
 *
 * `WorkService` is real (the production service over an in-memory graph store) so
 * the work-write tools can be driven end-to-end through a real `tools/call` — in
 * particular `arc.work.update`, the consolidated edit/status/priority/comment door.
 * `ReadService` is a stub: the tools under test never call it, which keeps this
 * suite focused on the MCP surface and its routing, not the wider domain (covered
 * by the per-service suites).
 */
const RealWorkService = WorkServiceLive.pipe(
  Layer.provide(WorkStoreLive),
  Layer.provide(sqliteLayer(":memory:")),
)
// Controllable state for the orchestration-tool stubs (arc.agent.send).
const stubTargets: Array<{ id: string; state: string; attached: boolean }> = []
const stubEnqueued: Array<{ targetSessionId: string; body: string }> = []

const StubServices = Layer.mergeAll(
  RealWorkService,
  Layer.succeed(ReadService, {} as never),
  Layer.succeed(ChatService, {} as never),
  Layer.succeed(TargetSessionManager, { list: Effect.sync(() => stubTargets) } as never),
  Layer.succeed(TargetInboxService, {
    enqueue: (targetSessionId: string, body: string) =>
      Effect.sync(() => {
        stubEnqueued.push({ targetSessionId, body })
      }),
  } as never),
)

const EXPECTED_TOOLS = [
  "arc.search",
  "arc.get",
  "arc.work.create",
  "arc.work.update",
  "arc.agent.spawn",
  "arc.prime",
  "arc.agent.send",
] as const

interface PostResult {
  readonly status: number
  readonly sessionId: string | null
  readonly text: string
}

/** Parse the JSON-RPC payload out of an MCP HTTP response (plain JSON or SSE `data:` frame). */
const parseRpc = (text: string): { result: { tools: ReadonlyArray<{ name: string; inputSchema: unknown }> } } => {
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text
  return JSON.parse(line.replace(/^data:\s*/, "")) as never
}

/** A `tools/call` result frame: the structured tool payload, or an error flag + text. */
interface CallResult {
  readonly structuredContent?: unknown
  readonly content?: ReadonlyArray<{ type: string; text?: string }>
  readonly isError?: boolean
}
const parseCallResult = (text: string): CallResult => {
  const line = text.split("\n").find((l) => l.startsWith("data:")) ?? text
  return (JSON.parse(line.replace(/^data:\s*/, "")) as { result: CallResult }).result
}

/** Recursively gather every string literal reachable from a JSON Schema node (enum entries + const). */
const collectLiterals = (node: unknown): ReadonlyArray<string> => {
  if (!node || typeof node !== "object") return []
  const obj = node as Record<string, unknown>
  const out: Array<string> = []
  if (Array.isArray(obj["enum"])) for (const v of obj["enum"]) if (typeof v === "string") out.push(v)
  if (typeof obj["const"] === "string") out.push(obj["const"] as string)
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branch = obj[key]
    if (Array.isArray(branch)) for (const b of branch) out.push(...collectLiterals(b))
  }
  return out
}

const post = async (url: string, body: unknown, sessionId?: string): Promise<PostResult> => {
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
    "mcp-protocol-version": "2025-06-18",
  }
  if (sessionId) headers["mcp-session-id"] = sessionId
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body) })
  return { status: res.status, sessionId: res.headers.get("mcp-session-id"), text: await res.text() }
}

describe("Arc MCP server", () => {
  let dir: string
  let prevDbPath: string | undefined
  // The HTTP server layer carries a `ServeError` in its error channel (bind
  // failure); widen rather than couple the test to platform-node's error type.
  let runtime: ManagedRuntime.ManagedRuntime<never, unknown>
  let url: string

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), "arc-mcp-test-"))
    prevDbPath = process.env["ARC_DB_PATH"]
    // Isolate the discovery file (written next to ARC_DB_PATH) and the ephemeral
    // port; resolution is read at layer build, so set before booting.
    process.env["ARC_DB_PATH"] = join(dir, "arc.sqlite")
    // Explicit ephemeral port: the default now binds the stable port (7793) and
    // *skips* if it's busy (no silent fallback), so pin an OS-chosen port to keep
    // this smoke test hermetic regardless of what else is on 7793.
    process.env["ARC_MCP_PORT"] = "0"

    runtime = ManagedRuntime.make(ArcMcpServerLive.pipe(Layer.provide(StubServices)))
    await runtime.runPromise(Effect.void) // force build → listen + write discovery file

    const discovery = JSON.parse(readFileSync(join(dir, "arc-mcp.json"), "utf8")) as { url?: string }
    url = discovery.url ?? ""
  })

  afterAll(async () => {
    await runtime.dispose()
    if (prevDbPath === undefined) delete process.env["ARC_DB_PATH"]
    else process.env["ARC_DB_PATH"] = prevDbPath
    delete process.env["ARC_MCP_PORT"]
    rmSync(dir, { recursive: true, force: true })
  })

  it("publishes a loopback endpoint to the discovery file", () => {
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/)
  })

  it("rejects a non-initialize request without a session id (route is mounted)", async () => {
    const res = await post(url, { jsonrpc: "2.0", id: 0, method: "ping", params: {} })
    expect(res.status).toBe(404)
  })

  it("serves the full toolkit over a real MCP handshake", async () => {
    const init = await post(url, {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "arc-mcp-test", version: "1.0.0" },
      },
    })
    expect(init.status).toBe(200)
    expect(init.sessionId).toBeTruthy()

    const tools = await post(
      url,
      { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
      init.sessionId!,
    )
    expect(tools.status).toBe(200)
    for (const name of EXPECTED_TOOLS) {
      expect(tools.text).toContain(name)
    }
  })

  // MCP's Streamable HTTP transport requires 202 Accepted + no body for a
  // JSON-RPC notification (no `id`). Effect's RPC transport answers with an empty
  // 200, which Codex's RMCP client parses as JSON → EOF → "transport closed" at
  // startup (openai/codex#20982). arc's `NotificationStatusFix` global middleware
  // rewrites empty-body 200 → 202; this asserts arc's behavior, not Effect's.
  it("returns 202 Accepted with no body for the initialized notification", async () => {
    const init = await post(url, {
      jsonrpc: "2.0",
      id: 5,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "arc-mcp-test", version: "1.0.0" },
      },
    })
    expect(init.status).toBe(200)
    expect(init.sessionId).toBeTruthy()

    const initialized = await post(
      url,
      { jsonrpc: "2.0", method: "notifications/initialized", params: {} },
      init.sessionId!,
    )
    expect(initialized.status).toBe(202)
    expect(initialized.text).toBe("")
  })

  // Interim: with the reviewer gate removed, MCP is the full work-graph door, so
  // `arc.work.update`'s `set.status` must expose every status — including closing
  // work (done/superseded) — otherwise work authored over MCP could only be closed
  // by hand in the UI. A gated close returns with the orchestration/permissions
  // layer. We assert the served enum is exactly the canonical WorkStatus set, so it
  // tracks the schema rather than a frozen copy.
  it("exposes the full WorkStatus set through arc.work.update", async () => {
    const init = await post(url, {
      jsonrpc: "2.0",
      id: 3,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "arc-mcp-test", version: "1.0.0" },
      },
    })
    const tools = await post(
      url,
      { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
      init.sessionId!,
    )
    const workUpdate = parseRpc(tools.text).result.tools.find((t) => t.name === "arc.work.update")
    expect(workUpdate).toBeDefined()
    // `set` is optional, so its struct is wrapped in an `anyOf` (object | null);
    // unwrap to the branch that carries `properties`.
    const propsOf = (node: unknown): Record<string, unknown> | undefined => {
      if (!node || typeof node !== "object") return undefined
      const obj = node as Record<string, unknown>
      if (obj["properties"]) return obj["properties"] as Record<string, unknown>
      if (Array.isArray(obj["anyOf"])) {
        for (const b of obj["anyOf"]) {
          const p = propsOf(b)
          if (p) return p
        }
      }
      return undefined
    }
    const setSchema = (workUpdate!.inputSchema as { properties?: Record<string, unknown> })
      .properties?.["set"]
    const statusSchema = propsOf(setSchema)?.["status"]
    const allowed = collectLiterals(statusSchema)
    expect([...allowed].sort()).toEqual([...WORK_STATUSES].sort())
  })

  // The consolidation's payoff: one `arc.work.update` call carries several edits,
  // applied in the documented order (revise → status → priority → comment), and
  // returns the work's final state plus the created comment. Driven end-to-end
  // against the real WorkService over the in-memory graph store.
  it("arc.work.update applies revise + status + priority + comment in one call", async () => {
    const init = await post(url, {
      jsonrpc: "2.0",
      id: 6,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "arc-mcp-test", version: "1.0.0" },
      },
    })
    const sid = init.sessionId!

    const created = await post(
      url,
      {
        jsonrpc: "2.0",
        id: 7,
        method: "tools/call",
        params: { name: "arc.work.create", arguments: { title: "draft proposal", body: "v1" } },
      },
      sid,
    )
    const work = parseCallResult(created.text).structuredContent as { id: string; status: string }
    expect(work.id).toMatch(/^work_/)
    expect(work.status).toBe("open")

    const updated = await post(
      url,
      {
        jsonrpc: "2.0",
        id: 8,
        method: "tools/call",
        params: {
          name: "arc.work.update",
          arguments: {
            workRefId: work.id,
            set: { body: "v2", status: "active", priority: "p1" },
            addComment: { body: "started" },
          },
        },
      },
      sid,
    )
    const payload = parseCallResult(updated.text).structuredContent as {
      work: { id: string; body: string; status: string; priority: string }
      comment?: { body: string; workRefId: string }
    }
    expect(payload.work.id).toBe(work.id)
    expect(payload.work.body).toBe("v2")
    expect(payload.work.status).toBe("active")
    expect(payload.work.priority).toBe("p1")
    expect(payload.comment?.body).toBe("started")
    expect(payload.comment?.workRefId).toBe(work.id)
  })

  it("arc.agent.send rejects an exited target instead of reporting it queued", async () => {
    // Valid target typeids (the tool's TargetId schema validates the argument).
    const liveId = "target_01kw09f93fenb8tagr6z6y4992"
    const deadId = "target_01kw0669hfferbxf2tayrtvabz"
    stubTargets.length = 0
    stubTargets.push({ id: liveId, state: "running", attached: true })
    stubTargets.push({ id: deadId, state: "exited", attached: false })
    stubEnqueued.length = 0

    const init = await post(url, {
      jsonrpc: "2.0",
      id: 11,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "arc-mcp-test", version: "1.0.0" },
      },
    })
    const send = (targetSessionId: string, id: number): Promise<PostResult> =>
      post(
        url,
        {
          jsonrpc: "2.0",
          id,
          method: "tools/call",
          params: { name: "arc.agent.send", arguments: { targetSessionId, body: "ping" } },
        },
        init.sessionId!,
      )

    // A running target queues + reports success.
    const live = parseCallResult((await send(liveId, 12)).text)
    expect(live.isError).toBeFalsy()
    expect(live.structuredContent).toMatchObject({ queued: true })
    expect(stubEnqueued).toHaveLength(1)

    // An exited target is rejected loudly — and crucially NOT queued (it could
    // never be surfaced), unlike the old code that returned `{ queued: true }`.
    const dead = parseCallResult((await send(deadId, 13)).text)
    expect(dead.isError).toBe(true)
    expect(stubEnqueued).toHaveLength(1)
  })

  it("arc.work.update rejects a call with no operation", async () => {
    const init = await post(url, {
      jsonrpc: "2.0",
      id: 9,
      method: "initialize",
      params: {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "arc-mcp-test", version: "1.0.0" },
      },
    })
    const res = await post(
      url,
      {
        jsonrpc: "2.0",
        id: 10,
        method: "tools/call",
        params: { name: "arc.work.update", arguments: { workRefId: "work_irrelevant" } },
      },
      init.sessionId!,
    )
    expect(parseCallResult(res.text).isError).toBe(true)
  })
})
