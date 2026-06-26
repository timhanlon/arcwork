import { Effect, Layer, Queue } from "effect"
import type { IpcMainEvent } from "electron"
import { type RpcMessage, RpcServer } from "effect/unstable/rpc"
import { ipcMain, webContents } from "./electron-optional.js"
import { RPC_CHANNEL, RPC_REPLY_CHANNEL } from "../shared/rpc.js"

/**
 * The main-side RPC transport: an `RpcServer.Protocol` over Electron IPC.
 *
 * Encoded client messages arrive on `RPC_CHANNEL` (`ipcRenderer.send`); encoded
 * server responses go back to the originating window on `RPC_REPLY_CHANNEL`
 * (`webContents.send`). The messages Effect RPC hands the transport are already
 * past the schema-encode boundary — string ids, plain payloads — so they are
 * structured-clone-safe and cross Electron IPC as-is. No `RpcSerialization`
 * (NDJSON/MsgPack) byte layer is needed; this is the same shape the built-in
 * worker transport uses over `postMessage`.
 *
 * ## One logical client per renderer *load*, not per window
 *
 * `RpcServer` keeps per-client state (request-id map, fibers, an `ended` flag)
 * keyed by clientId, and the renderer's `RpcClient` numbers its requests from a
 * counter that resets to zero on every page load. A `WebContents` id is stable
 * across a reload, so keying the server client by it would make a reloaded
 * renderer reuse request ids against the *previous* connection's lingering
 * state — and `RpcServer.handleRequest` silently `interrupt`s a request whose id
 * it already holds. The renderer would hang with no replies, every list empty;
 * a fresh boot worked only because it had no prior state.
 *
 * So each renderer *load* gets its own monotonic logical clientId. `WebContents`
 * lifecycle (`did-start-loading` on reload/navigation, `destroyed` on close)
 * retires the old clientId — disconnecting it in `RpcServer` — and the next
 * message from that window allocates a fresh one. The reloaded client therefore
 * always meets a server with zero prior state, so its reset request ids can't
 * collide. Replies route by mapping clientId back to its `WebContents`.
 *
 * Lifecycle is the layer scope: the `ipcMain` listener and receive-loop fiber are
 * registered on build and torn down when the scope closes (runtime dispose).
 */
export const ElectronRpcServerProtocol = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      // This transport bridges renderer windows, so it only runs inside a real
      // Electron main process — never under the headless harness, which doesn't
      // build the RPC server layer at all.
      if (!ipcMain || !webContents) {
        return yield* Effect.die(new Error("RPC transport requires an Electron main process"))
      }
      const ipcMainApi = ipcMain
      const webContentsApi = webContents
      const disconnects = yield* Queue.make<number>()
      const inbox = yield* Queue.make<{
        readonly clientId: number
        readonly message: RpcMessage.FromClientEncoded
      }>()

      let nextClientId = 1
      const clientIdByWc = new Map<number, number>() // WebContents id -> current clientId
      const wcByClientId = new Map<number, number>() // clientId -> WebContents id (reply routing)
      const wired = new Set<number>() // WebContents we've attached lifecycle to (once each)

      /** Retire a window's current logical client, if any, and disconnect it. */
      const retire = (wcId: number): void => {
        const clientId = clientIdByWc.get(wcId)
        if (clientId === undefined) return
        clientIdByWc.delete(wcId)
        wcByClientId.delete(clientId)
        Queue.offerUnsafe(disconnects, clientId)
      }

      /** The window's live clientId, allocating a fresh one after a retire. */
      const clientIdFor = (wcId: number): number => {
        let clientId = clientIdByWc.get(wcId)
        if (clientId === undefined) {
          clientId = nextClientId++
          clientIdByWc.set(wcId, clientId)
          wcByClientId.set(clientId, wcId)
        }
        return clientId
      }

      const onMessage = (event: IpcMainEvent, message: RpcMessage.FromClientEncoded): void => {
        const sender = event.sender
        const wcId = sender.id
        // Attach lifecycle once per window. `did-start-loading` fires on every
        // (re)load start; we attach it after the first request — i.e. after the
        // initial load — so it only ever signals a *re*load, retiring the client
        // whose JS context is going away.
        if (!wired.has(wcId)) {
          wired.add(wcId)
          sender.on("did-start-loading", () => retire(wcId))
          sender.once("destroyed", () => {
            wired.delete(wcId)
            retire(wcId)
          })
        }
        Queue.offerUnsafe(inbox, { clientId: clientIdFor(wcId), message })
      }
      ipcMainApi.on(RPC_CHANNEL, onMessage)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => ipcMainApi.removeListener(RPC_CHANNEL, onMessage)),
      )

      // Raw listener -> queue -> server receive loop, so each message is fed to
      // `writeRequest` inside Effect rather than from the bare Node callback.
      yield* Queue.take(inbox).pipe(
        Effect.flatMap(({ clientId, message }) => writeRequest(clientId, message)),
        Effect.forever,
        Effect.forkScoped,
      )

      return {
        disconnects,
        send: (clientId, response) =>
          Effect.sync(() => {
            const wcId = wcByClientId.get(clientId)
            if (wcId === undefined) return
            const wc = webContentsApi.fromId(wcId)
            if (wc && !wc.isDestroyed()) wc.send(RPC_REPLY_CHANNEL, response)
          }),
        end: () => Effect.void,
        clientIds: Effect.sync(() => new Set(wcByClientId.keys())),
        initialMessage: Effect.succeedNone,
        supportsAck: true,
        supportsTransferables: false,
        supportsSpanPropagation: false,
      }
    }),
  ),
)
