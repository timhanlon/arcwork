import { Cause, Effect, Exit, Layer, ManagedRuntime, Queue, Scope } from "effect"
import { type Rpc, RpcClient, type RpcMessage } from "effect/unstable/rpc"
import { ArcRpcError, ArcRpcs, type ArcRpc, type RpcError } from "../../shared/rpc.js"
import { devLog, waitForBridge } from "./bridge.js"

/**
 * First-class dev observability for the renderer RPC client: `[arc/rpc]` console
 * lines (Default level) tracing the client lifecycle and per-call traffic —
 * Electron IPC never shows in the DevTools Network panel, so these are how you
 * watch it. Gated on Vite's build-time dev flag, independent of `window.arc`.
 */
const log = devLog("[arc/rpc]")

const frameTag = (message: unknown): string =>
  (message as { _tag?: string } | null)?._tag ?? "?"

type ArcFlatRpcClient = RpcClient.RpcClient.Flat<ArcRpc>

/**
 * The renderer end of the RPC seam: a real `effect/unstable/rpc` client over a
 * custom Electron `RpcClient.Protocol`. The protocol ships encoded client
 * messages to main via the preload bridge (`window.arc.rpcSend` ->
 * `ipcRenderer.send`) and feeds encoded server replies back in
 * (`window.arc.onRpcMessage` <- `ipcRenderer.on`). The messages are already past
 * the schema-encode boundary, so they cross structured clone untouched — no
 * envelope, no per-tag decode here. The protocol only builds once `window.arc`
 * is present (see `waitForBridge`), so its bridge access is always safe.
 */
export const ElectronRpcClientProtocol = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      yield* Effect.promise(() => waitForBridge())
      const inbox = yield* Queue.make<RpcMessage.FromServerEncoded>()
      const off = window.arc.onRpcMessage((message) => {
        log("recv", { frame: frameTag(message) })
        Queue.offerUnsafe(inbox, message as RpcMessage.FromServerEncoded)
      })
      yield* Effect.addFinalizer(() => Effect.sync(off))
      // Single renderer client => clientId 0 (matches RpcClient's first client).
      yield* Queue.take(inbox).pipe(
        Effect.flatMap((message) => writeResponse(0, message)),
        Effect.forever,
        Effect.forkScoped,
      )
      return {
        send: (_clientId, request) =>
          Effect.sync(() => {
            log("send-frame", { frame: frameTag(request) })
            window.arc.rpcSend(request)
          }),
        supportsAck: true,
        supportsTransferables: false,
      }
    }),
  ),
)

/**
 * Build the runtime + client once, lazily, after the bridge is present — the
 * receive loop and the client's pending-request map must outlive any one call,
 * so the scope is kept open for the renderer's lifetime.
 */
const buildClient = async () => {
  log("init", { bridge: !!window.arc })
  await waitForBridge()
  log("building client")
  const runtime = ManagedRuntime.make(ElectronRpcClientProtocol)
  try {
    const client: ArcFlatRpcClient = await runtime.runPromise(
      Effect.flatMap(Scope.make(), (scope) =>
        RpcClient.make(ArcRpcs, { flatten: true }).pipe(Effect.provideService(Scope.Scope, scope)),
      ),
    )
    log("client ready")
    return { runtime, client }
  } catch (error) {
    log("client build FAILED", { error: String(error) })
    throw error
  }
}

let pending: ReturnType<typeof buildClient> | undefined
const ensureClient = (): ReturnType<typeof buildClient> => (pending ??= buildClient())

export const sharedFlatRpcClient = Effect.promise(() => ensureClient().then(({ client }) => client))

const isRpcError = (error: unknown): error is RpcError =>
  typeof error === "object" &&
  error !== null &&
  "_tag" in error &&
  ((error as Record<string, unknown>)["_tag"] === "ArcRequestError" ||
    (error as Record<string, unknown>)["_tag"] === "ArcUnexpectedError") &&
  typeof (error as Record<string, unknown>)["message"] === "string"

/**
 * Fold a failed call into the renderer's `ArcRpcError`. A structured `RpcError`
 * from a handler passes through verbatim; a transport-level `RpcClientError`
 * (decode/protocol fault) is logged and collapsed to a generic unexpected error,
 * mirroring how main hides internals behind a clean message.
 */
const toArcRpcError = (error: unknown, logTransportError: (error: unknown) => void): ArcRpcError => {
  if (isRpcError(error)) return new ArcRpcError(error)
  // A transport fault is collapsed to a generic message for the caller, but the
  // detail would otherwise be lost — log the cause through Effect (not console)
  // so it stays on the same observability seam as everything else.
  logTransportError(error)
  return new ArcRpcError({ _tag: "ArcUnexpectedError", message: "Unexpected RPC transport error" })
}

/**
 * Typed client over the IPC bridge. Callers use the Effect RPC flat-client
 * shape directly: tag plus payload. This keeps renderer code aligned with
 * `RpcClient.make(..., { flatten: true })` and `AtomRpc.Service({ makeEffect })`.
 * On failure it throws a typed {@link ArcRpcError} (clean message, no
 * `Error invoking remote method …` wrapper) for a caller's `catch (e)`.
 */
export async function rpc<const T extends ArcRpc["_tag"]>(
  tag: T,
  payload: Rpc.PayloadConstructor<Rpc.ExtractTag<ArcRpc, T>>,
): Promise<Rpc.Success<Rpc.ExtractTag<ArcRpc, T>>> {
  log("call", { tag })
  const { runtime, client } = await ensureClient()

  // The call is a traced `rpc.client.<tag>` span for any OTLP backend; the
  // visible dev trace is the `[arc/rpc]` console lines around it.
  const call = (
    client as (tag: T, payload: Rpc.PayloadConstructor<Rpc.ExtractTag<ArcRpc, T>>) => Effect.Effect<
      Rpc.Success<Rpc.ExtractTag<ArcRpc, T>>,
      RpcError
    >
  )(tag, payload).pipe(
    Effect.withSpan(`rpc.client.${tag}`, { attributes: { "rpc.tag": tag } }),
  )
  const exit = await runtime.runPromiseExit(call)
  if (Exit.isSuccess(exit)) {
    log("ok", { tag })
    return exit.value
  }
  const error = toArcRpcError(Cause.squash(exit.cause), (cause) => {
    runtime.runFork(
      Effect.logError("rpc transport error", cause).pipe(
        Effect.annotateLogs({ "arc.renderer.context": "rpc transport" }),
      ),
    )
  })
  log("failed", { tag, message: error.message })
  throw error
}
