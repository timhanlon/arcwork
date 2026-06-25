import { Effect, Exit, Layer, ManagedRuntime, References, Scope } from "effect"
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { ChatService } from "../services/ChatService.js"
import { WorkspaceService } from "../services/WorkspaceService.js"
import { launchArcMainController, type RendererTransport } from "../services/ArcMainController.js"
import { AppLive } from "../runtime.js"
import { ArcMcpServerLive } from "../mcp/server.js"
import { newArcId } from "../../shared/ids.js"
import { writeHeadlessLatest } from "./headless-latest.js"

/**
 * Headless Arc backend — the autonomous test harness. Boots the *real* main-
 * process runtime (AppLive: store, session manager, hook plane, work graph, the
 * inbox/delivery coordinator) plus the in-process MCP server, but no renderer and
 * no RPC/ipcMain surface, so it runs under `ELECTRON_RUN_AS_NODE` (which gives the
 * native ABI better-sqlite3/node-pty need) with no window and no human.
 *
 * Seeds one workspace + chat so there's somewhere to spawn into, prints the live
 * coordinates as one JSON line, then stays alive (the MCP HTTP listener holds the
 * event loop). Drive it over MCP (e.g. arc.agent.spawn provider=pi), observe the
 * result in the temp sqlite. Ctrl-C / SIGTERM tears it down cleanly.
 *
 *   electron-vite build && \
 *   ELECTRON_RUN_AS_NODE=1 ARC_PROFILE=dev electron out/main/arc-headless.js
 */

const transport: RendererTransport = { broadcast: () => {} }

const main = async (): Promise<void> => {
  // A temp profile DB unless one is pinned, so the harness never collides with a
  // running dev/stable app (or its MCP port). Resolved lazily by the sqlite layer,
  // so it must be set before the runtime builds.
  if (!process.env["ARC_DB_PATH"]) {
    process.env["ARC_DB_PATH"] = join(mkdtempSync(join(tmpdir(), "arc-headless-")), "arc.sqlite")
  }
  // Ephemeral MCP port by default — the persistent 7793/7794 are likely taken by a
  // real app, and this instance is throwaway.
  if (!process.env["ARC_MCP_PORT"]) process.env["ARC_MCP_PORT"] = "0"
  const dbPath = process.env["ARC_DB_PATH"]

  // A real on-disk cwd a spawned agent can work in.
  const cwd = process.env["ARC_HEADLESS_CWD"] ?? mkdtempSync(join(tmpdir(), "arc-headless-cwd-"))

  const runtime = ManagedRuntime.make(
    Layer.mergeAll(AppLive, ArcMcpServerLive.pipe(Layer.provide(AppLive))).pipe(
      Layer.provideMerge(Layer.succeed(References.MinimumLogLevel, "Info")),
    ),
  )

  // Seed through the services (not the store) so their in-memory lists — which
  // TargetSessionManager.launch reads — actually contain the chat/workspace.
  const seeded = await runtime.runPromise(
    Effect.gen(function* () {
      const workspaces = yield* WorkspaceService
      const chats = yield* ChatService
      const ws = yield* workspaces.openAt(cwd)
      const chat = yield* chats.create(ws.id, "headless")
      return { workspaceId: ws.id, chatId: chat.id }
    }),
  )

  const scope = Scope.makeUnsafe()
  await runtime.runPromise(
    launchArcMainController(transport, (effect) => runtime.runFork(effect)).pipe(Scope.provide(scope)),
  )

  // The MCP server wrote its discovery file next to the DB once it bound a port.
  let mcpUrl: string | undefined
  try {
    mcpUrl = (JSON.parse(readFileSync(join(dirname(dbPath), "arc-mcp.json"), "utf8")) as { url?: string }).url
  } catch {
    /* discovery file not ready — reported as undefined */
  }

  // A fresh, well-formed driver bearer: `target_<26>:<chatId>`. The target
  // segment must be a valid typeid or the MCP server drops the provenance, so
  // mint it through the same factory the store uses.
  const bearer = `${newArcId("target")}:${seeded.chatId}`

  // Publish coordinates two ways: one machine-readable stdout line (kept for
  // existing greppers) and the well-known `headless-latest.json` that `arc-drive`
  // auto-discovers with zero arguments.
  const coords = { mcpUrl, dbPath, cwd, chatId: seeded.chatId, workspaceId: seeded.workspaceId, bearer }
  writeHeadlessLatest(coords)
  console.log("ARC_HEADLESS_READY " + JSON.stringify(coords))

  const shutdown = async (): Promise<void> => {
    await runtime.runPromise(Scope.close(scope, Exit.succeed(undefined)))
    await runtime.dispose()
    process.exit(0)
  }
  process.on("SIGINT", () => void shutdown())
  process.on("SIGTERM", () => void shutdown())
  // Stay alive: the MCP HTTP listener + controller fibers hold the event loop.
}

main().catch((error: unknown) => {
  console.error(error)
  process.exit(1)
})
