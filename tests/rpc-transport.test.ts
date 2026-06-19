import { Cause, Effect, Exit, Layer, ManagedRuntime, Queue, Schema, Stream } from "effect"
import { RpcClient, RpcServer } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { ArcRpcs } from "../src/shared/rpc.js"
import { ArcRpcHandlersLive } from "../src/main/rpc.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import { WorkStoreLive } from "../src/main/work/store.js"
import { WorkServiceLive } from "../src/main/work/service.js"
import { Work } from "../src/shared/work.js"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { ChatService, ChatServiceLive } from "../src/main/services/ChatService.js"
import { ChatMessageService } from "../src/main/services/ChatMessageService.js"
import { ReadServiceLive } from "../src/main/read/service.js"

/**
 * The renderer<->main RPC transport, exercised in-process.
 *
 * The shipped transport is a real Effect RPC client/server pair over Electron
 * IPC: `RpcClient.make(ArcRpcs)` behind the renderer protocol in
 * `renderer/src/rpc-client.ts`, and `RpcServer.layer(ArcRpcs)` behind the main
 * protocol in `main/rpc-transport.ts`. Both forward Effect's encoded
 * `FromClientEncoded` / `FromServerEncoded` messages — already past the
 * schema-encode boundary (string ids, `[string,string][]` headers, encoded
 * payloads) — straight across IPC with no `RpcSerialization` byte layer, because
 * those envelopes are structured-clone-safe.
 *
 * Those protocol modules are thin adapters over `ipcMain`/`webContents` and
 * `window.arc` — surfaces absent under vitest. So this test stands in for them
 * with a pair of queues whose every message is run through `structuredClone`:
 * the exact transform Electron's `contextBridge`/`ipcRenderer` apply (and which
 * throws `DataCloneError` on anything non-clonable). Everything else is real —
 * `RpcClient.make(ArcRpcs)`, `RpcServer.layer(ArcRpcs)`, the Work handlers, an
 * in-memory DB. A real `CreateWork` round trip and a typed `RpcError` failure
 * prove the contract, handlers, and encode/decode survive the clone boundary the
 * live protocols use.
 *
 * Not covered (validated by running the app): the literal `ipcRenderer.send` /
 * `webContents.send` channels, which only add a process boundary around the same
 * structured-clone transform exercised here.
 */

// WorkService reads ArcStore (optionally) to stamp a unit of work with the
// workspace its authoring chat belongs to; without it, work is authored
// workspace-less and never surfaces in a workspace-scoped search.
const WorkLive = WorkServiceLive.pipe(Layer.provide(Layer.mergeAll(WorkStoreLive, ArcStoreLive)))
const ChatsLive = ChatServiceLive.pipe(Layer.provide(ArcStoreLive))
const ChatMessagesStub = Layer.succeed(
  ChatMessageService,
  ChatMessageService.of({
    listForChat: () => Effect.succeed([]),
    getById: () => Effect.succeed(null),
    listPending: Effect.succeed([]),
    changes: Stream.empty,
    ingestSignal: () => Effect.succeed(0),
    ingestArtifactSession: () => Effect.succeed(0),
    supersedePendingForTarget: () => Effect.succeed(0),
    reprojectChat: () => Effect.succeed({ deleted: 0, inserted: 0 }),
    sendPrompt: () => Effect.die("ChatMessageService.sendPrompt is unused in this test"),
  }),
)
const ReadLive = ReadServiceLive.pipe(Layer.provide(Layer.mergeAll(WorkLive, ChatsLive, ChatMessagesStub)))

/** The Electron IPC hop, modelled exactly: structured clone or bust. */
const ipc = <T>(message: T): T => structuredClone(message)

// Two directional wires between the (in-process) renderer and main "processes".
// Queues, not direct calls, so each side's receive loop runs in its own fiber
// under its own runtime context — same shape as the stdio/worker protocols.
const toMain = Effect.runSync(Queue.make<unknown>())
const toRenderer = Effect.runSync(Queue.make<unknown>())

/**
 * MAIN side. `RpcServer.Protocol.make` gives us `writeRequest` (feed a decoded
 * client message into the server) and asks us for `send` (hand a server response
 * to the transport). This is what would sit on `ipcMain.handle` / `webContents`.
 */
const ServerProtocol = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const disconnects = yield* Queue.make<number>()
      // Receive loop: client -> main.
      yield* Queue.take(toMain).pipe(
        Effect.flatMap((message) => writeRequest(0, message as never)),
        Effect.forever,
        Effect.forkScoped,
      )
      return {
        disconnects,
        // main -> renderer (the IPC hop happens here).
        send: (_clientId, response) => Queue.offer(toRenderer, ipc(response)),
        end: () => Effect.void,
        clientIds: Effect.succeed(new Set([0])),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      }
    }),
  ),
)

/**
 * RENDERER side. `RpcClient.Protocol.make` gives us `writeResponse` (feed a
 * server message into the client) and asks us for `send` (hand a client request
 * to the transport). This is what would call `ipcRenderer.invoke`.
 */
const ClientProtocol = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      // Receive loop: main -> renderer.
      yield* Queue.take(toRenderer).pipe(
        Effect.flatMap((message) => writeResponse(0, message as never)),
        Effect.forever,
        Effect.forkScoped,
      )
      return {
        // renderer -> main (the IPC hop happens here).
        send: (_clientId, request) => Queue.offer(toMain, ipc(request)),
        supportsAck: true,
        supportsTransferables: false,
      }
    }),
  ),
)

// One in-memory DB shared by the server and the test's seeding surface. The
// same layer reference on both sides memoizes to a single SqlClient, so the
// workspace/chat seeded below are visible to the server's handlers (`:memory:`
// is per-connection — sharing the connection is what makes that work).
const Sqlite = sqliteLayer(":memory:")

// The real server: contract + handlers + our IPC-shaped protocol, backed by the
// shared in-memory DB. `ArcRpcHandlersLive` references every arc service in its
// type; only the Work/Read handlers are exercised here, so the rest are never
// forced — the requirement is erased exactly as production's `handleRpcEffect`
// does (`as never`). The cast is the one concession this spike makes to staying
// small.
const ServerLive = RpcServer.layer(ArcRpcs).pipe(
  Layer.provide(ArcRpcHandlersLive),
  Layer.provide(ServerProtocol),
  Layer.provide(ReadLive),
  Layer.provide(ChatsLive),
  Layer.provide(ArcStoreLive),
  Layer.provide(WorkLive),
  Layer.provide(WorkStoreLive),
  Layer.provide(Sqlite),
) as unknown as Layer.Layer<never>

// Search now scopes to a chat's workspace, so the test seeds one directly: this
// exposes `ArcStore` + `ChatService` over the same DB the server reads, letting
// the program create a workspace and chat to anchor `CreateWork`/`SearchArc`.
const SetupLive = Layer.mergeAll(ArcStoreLive, ChatsLive).pipe(Layer.provide(Sqlite))

describe("arc rpc transport (structured-clone IPC)", () => {
  it("round-trips real Work RPCs through RpcClient.make <-> RpcServer over a clone boundary", async () => {
    const runtime = ManagedRuntime.make(Layer.mergeAll(ClientProtocol, ServerLive, SetupLive))
    try {
      const result = await runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(ArcRpcs)

          // Seed a workspace + chat so the work has a workspace to be authored
          // in and search has a chat to anchor its scope to (both reads now
          // require it). Done off the RPC client, against the server's own DB.
          const arc = yield* ArcStore
          const chats = yield* ChatService
          yield* arc.upsertWorkspace({
            id: "ws_rpc",
            path: "/tmp/ws_rpc",
            name: "rpc ws",
            createdAt: "2026-06-08T00:00:00.000Z",
            lastOpenedAt: "2026-06-08T00:00:00.000Z",
          })
          const chat = yield* chats.create("ws_rpc", "rpc chat")

          // Success path: a real create, then a real list, both decoded by the
          // typed client — no envelope, no dynamic schema cast. `chatId` anchors
          // the work to the seeded workspace.
          const created = yield* client.CreateWork({
            input: { title: "rpc work", body: "via real transport", labels: ["rpc"] },
            chatId: chat.id,
          })
          const listed = yield* client.ListWork(undefined)
          const searched = yield* client.SearchArc({
            params: { query: "rpc", kinds: ["work"], filters: { chatId: chat.id } },
          })

          // The comments read path decodes its own listing schema across the
          // clone boundary — empty here, but the currentNodeId/comments/count
          // shape must round-trip for the UI to read it.
          const comments = yield* client.ListWorkComments({ id: created.id })

          // Error path: the handler fails with ArcRequestError; the typed client
          // surfaces it as a structured RpcError on the error channel.
          const failure = yield* Effect.exit(
            client.UpdateWorkStatus({ id: "work_does_not_exist", status: "done" }),
          )

          return { created, listed, searched, comments, failure }
        }).pipe(Effect.scoped),
      )

      // Success decoded end to end.
      expect(result.created).toMatchObject({
        _tag: "Work",
        title: "rpc work",
        body: "via real transport",
        labels: ["rpc"],
        provenance: { source: "rpc" },
      })
      // The created Work came back as a real decoded instance, not raw JSON.
      expect(Schema.is(Work)(result.created)).toBe(true)

      expect(result.listed).toHaveLength(1)
      expect(result.listed[0]).toMatchObject({ id: result.created.id, title: "rpc work" })
      expect(result.searched.hits).toHaveLength(1)
      expect(result.searched.hits[0]).toMatchObject({ ref: result.created.id, kind: "work", title: "rpc work" })

      // The comment listing decoded end to end: a current revision node, no
      // comments yet, and no older-revision comments.
      expect(result.comments).toMatchObject({
        currentNodeId: result.created.nodeId,
        comments: [],
        olderRevisionCommentCount: 0,
      })

      // Error arrived as a typed RpcError on the error channel.
      expect(Exit.isFailure(result.failure)).toBe(true)
      if (Exit.isFailure(result.failure)) {
        const error = Cause.squash(result.failure.cause) as { _tag: string; message: string }
        expect(error).toMatchObject({ _tag: "ArcRequestError" })
        expect(typeof error.message).toBe("string")
      }
    } finally {
      await runtime.dispose()
    }
  })
})
