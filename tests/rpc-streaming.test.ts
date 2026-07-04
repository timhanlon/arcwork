import { Effect, Layer, ManagedRuntime, Queue, Schema, Stream } from "effect"
import { RpcClient, RpcServer } from "effect/unstable/rpc"
import { describe, expect, it } from "vitest"
import { ArcRpcs } from "../src/shared/rpc.js"
import { ArcRpcHandlersLive } from "../src/main/rpc.js"
import { TargetSession } from "../src/shared/instance.js"
import { SessionRuntimeRouter } from "../src/main/services/SessionRuntimeRouter.js"
import { newArcId } from "../src/shared/ids.js"

/**
 * The renderer<->main RPC transport carrying a *streaming* RPC, exercised
 * in-process — the sibling of `rpc-transport.test.ts` (which covers
 * one-shot calls). `WatchSessions` is the first list moved off the custom
 * `arc:sessions` IPC push onto an Effect RPC server stream.
 *
 * Same harness shape: a pair of queues whose every message is run through
 * `structuredClone` (the exact transform Electron's `contextBridge`/`ipcRenderer`
 * apply), with the real `RpcClient.make(ArcRpcs)` / `RpcServer.layer(ArcRpcs)` on
 * either end. A real streaming round trip — collected to completion — proves the
 * ack-based chunk protocol and per-chunk decode survive the clone boundary the
 * live protocols use.
 *
 * This lives in its own file (not alongside the one-shot test) deliberately:
 * vitest isolates files, and a streaming collect that shares module state with a
 * prior one-shot test in the same file deadlocks on residue between them.
 *
 * Only the `WatchSessions` handler is forced, so only `SessionRuntimeRouter` (which
 * backs it — the unified PTY+rpc session view) is provided; the rest of
 * `ArcRpcHandlersLive`'s requirements are never run and are erased with the same
 * `as never` cast the one-shot transport test uses.
 */

// Two session-list snapshots the streaming handler emits, to prove each chunk
// round-trips and decodes as a real `TargetSession`. A finite `Stream.fromIterable`
// (not a live SubscriptionRef) so `Stream.runCollect` terminates.
// Valid TypeIDs (not short fixture ids): the snapshots round-trip through the
// real RPC schema decode, which validates the `target_…` pattern per chunk.
const SESS_A = newArcId("target")
const SESS_B = newArcId("target")
const CHAT_STREAM = newArcId("chat")
const sessionSnapshot = (ids: ReadonlyArray<TargetSession["id"]>): ReadonlyArray<TargetSession> =>
  ids.map((id) => ({
    _tag: "TargetSession" as const,
    id,
    provider: "claude",
    chatId: CHAT_STREAM,
    cwd: "/tmp/ws_rpc",
    attached: false,
    state: "unknown" as const,
    startedAt: "2026-06-08T00:00:00.000Z",
  }))
const SNAPSHOT_A = sessionSnapshot([SESS_A])
const SNAPSHOT_AB = sessionSnapshot([SESS_A, SESS_B])
const SESSION_SNAPSHOTS = [SNAPSHOT_A, SNAPSHOT_AB]

const SessionRuntimeRouterStub = Layer.succeed(
  SessionRuntimeRouter,
  SessionRuntimeRouter.of({
    sessions: Effect.succeed(SNAPSHOT_A),
    changes: Stream.fromIterable(SESSION_SNAPSHOTS),
    launch: () => Effect.die("SessionRuntimeRouter.launch is unused in this test"),
    submit: () => Effect.die("SessionRuntimeRouter.submit is unused in this test"),
    stop: () => Effect.succeed({ stopped: false }),
    ownsRpc: () => Effect.succeed(false),
  }),
)

/** The Electron IPC hop, modelled exactly: structured clone or bust. */
const ipc = <T>(message: T): T => structuredClone(message)

// Two directional wires between the (in-process) renderer and main "processes".
const toMain = Effect.runSync(Queue.make<unknown>())
const toRenderer = Effect.runSync(Queue.make<unknown>())

// MAIN side: feed client messages into the server, ship server responses back.
const ServerProtocol = Layer.effect(
  RpcServer.Protocol,
  RpcServer.Protocol.make(
    Effect.fnUntraced(function* (writeRequest) {
      const disconnects = yield* Queue.make<number>()
      yield* Queue.take(toMain).pipe(
        Effect.flatMap((message) => writeRequest(0, message as never)),
        Effect.forever,
        Effect.forkScoped,
      )
      return {
        disconnects,
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

// RENDERER side: feed server messages into the client, ship client requests out.
const ClientProtocol = Layer.effect(
  RpcClient.Protocol,
  RpcClient.Protocol.make(
    Effect.fnUntraced(function* (writeResponse) {
      yield* Queue.take(toRenderer).pipe(
        Effect.flatMap((message) => writeResponse(0, message as never)),
        Effect.forever,
        Effect.forkScoped,
      )
      return {
        send: (_clientId, request) => Queue.offer(toMain, ipc(request)),
        supportsAck: true,
        supportsTransferables: false,
      }
    }),
  ),
)

const ServerLive = RpcServer.layer(ArcRpcs).pipe(
  Layer.provide(ArcRpcHandlersLive),
  Layer.provide(ServerProtocol),
  Layer.provide(SessionRuntimeRouterStub),
) as unknown as Layer.Layer<never>

describe("arc rpc streaming transport (structured-clone IPC)", () => {
  it("streams WatchSessions chunks through RpcClient.make <-> RpcServer over a clone boundary", async () => {
    const runtime = ManagedRuntime.make(Layer.mergeAll(ClientProtocol, ServerLive))
    try {
      const snapshots = await runtime.runPromise(
        Effect.gen(function* () {
          const client = yield* RpcClient.make(ArcRpcs)
          // The streaming RPC returns a Stream; collecting it drives the ack-based
          // chunk protocol across the structured-clone hop. The handler's finite
          // `changes` stream completes, so the collect terminates.
          return yield* Stream.runCollect(client.WatchSessions(undefined))
        }).pipe(Effect.scoped),
      )

      // Both snapshots arrived in order, decoded as real TargetSessions.
      expect(snapshots).toHaveLength(2)
      const [first, second] = snapshots
      if (first === undefined || second === undefined) throw new Error("expected two snapshots")
      expect(first.map((s) => s.id)).toEqual([SESS_A])
      expect(second.map((s) => s.id)).toEqual([SESS_A, SESS_B])
      expect(second.every((s) => Schema.is(TargetSession)(s))).toBe(true)
    } finally {
      await runtime.dispose()
    }
  })
})
