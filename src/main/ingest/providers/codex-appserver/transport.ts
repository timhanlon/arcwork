import { spawn } from "node:child_process"
import { createInterface } from "node:readline"
import { Data, Deferred, Effect, Queue, type Scope, Stream } from "effect"

/**
 * A generic newline-delimited JSON-RPC 2.0 client over a child process's stdio —
 * the transport `codex app-server` speaks (`--listen stdio://`, the default).
 * Deliberately Codex-agnostic: it knows only the three JSON-RPC message shapes,
 * so the codex-specific method names and payload schemas live one layer up in
 * the adapter. Framing omits the `"jsonrpc":"2.0"` header, matching the server.
 *
 * Three inbound shapes are routed:
 *   - **response** — has `id` + (`result`|`error`), no `method` → resolves the
 *     matching in-flight {@link AppServerTransport.request}.
 *   - **server request** — has `id` + `method` → the server asking the client
 *     (e.g. an approval); surfaced on {@link AppServerTransport.serverRequests}
 *     for the client to answer with {@link AppServerTransport.respond}.
 *   - **notification** — `method`, no `id` → surfaced on
 *     {@link AppServerTransport.notifications}.
 *
 * The raw `readline`/`exit` callbacks only `Queue.offerUnsafe` onto an inbound
 * queue (a no-op once shut down at scope close); a single scoped fiber drains it
 * and applies all Effectful routing — the same raw-callback→queue→scoped-fiber
 * seam the PTY manager uses. On process exit every pending request is failed and
 * the two output streams end, so no caller hangs on a dead server.
 */
export class AppServerTransportError extends Data.TaggedError("AppServerTransportError")<{
  readonly message: string
  readonly cause?: unknown
}> {}

type IdKey = number | string
type Rec = Record<string, unknown>

export interface JsonRpcNotification {
  readonly method: string
  readonly params: unknown
}

export interface JsonRpcServerRequest {
  readonly id: IdKey
  readonly method: string
  readonly params: unknown
}

export interface AppServerTransport {
  /** Send a request and await its response `result` (decode with Schema). Fails on a JSON-RPC error or process death. */
  readonly request: (method: string, params?: unknown) => Effect.Effect<unknown, AppServerTransportError>
  /** Fire-and-forget notification (no response expected). */
  readonly notify: (method: string, params?: unknown) => Effect.Effect<void, AppServerTransportError>
  /** Answer a server→client request (e.g. an approval decision). */
  readonly respond: (id: IdKey, result: unknown) => Effect.Effect<void, AppServerTransportError>
  /** Server notifications, in arrival order. Ends when the process exits. */
  readonly notifications: Stream.Stream<JsonRpcNotification>
  /** Server→client requests, in arrival order. Ends when the process exits. */
  readonly serverRequests: Stream.Stream<JsonRpcServerRequest>
}

export interface AppServerTransportOptions {
  /** Command to spawn, e.g. `"codex"`. */
  readonly command: string
  /** Args, e.g. `["app-server"]`. */
  readonly args?: ReadonlyArray<string>
  readonly cwd?: string
  readonly env?: Record<string, string>
}

type Inbound = { readonly kind: "message"; readonly msg: Rec } | { readonly kind: "exit" }

/** Spawn an app-server child and return a scoped transport (killed on scope close). */
export const makeAppServerTransport = (
  options: AppServerTransportOptions,
): Effect.Effect<AppServerTransport, AppServerTransportError, Scope.Scope> =>
  Effect.gen(function* () {
    const child = yield* Effect.acquireRelease(
      Effect.sync(() =>
        spawn(options.command, [...(options.args ?? [])], {
          stdio: ["pipe", "pipe", "inherit"],
          cwd: options.cwd,
          env: options.env ? { ...process.env, ...options.env } : process.env,
        }),
      ),
      (proc) =>
        Effect.sync(() => {
          try {
            proc.kill()
          } catch {
            /* already gone */
          }
        }),
    )

    const stdin = child.stdin
    const stdout = child.stdout
    if (!stdin || !stdout) {
      return yield* Effect.fail(
        new AppServerTransportError({ message: `${options.command} spawned without stdio pipes` }),
      )
    }

    const inbound = yield* Queue.make<Inbound>()
    const notifications = yield* Queue.make<JsonRpcNotification>()
    const serverRequests = yield* Queue.make<JsonRpcServerRequest>()
    const pending = new Map<IdKey, Deferred.Deferred<unknown, AppServerTransportError>>()
    let nextId = 1
    // Set once the child exits (see the exit branch of `route`). A request made
    // *after* the exit event would otherwise register a Deferred that no future
    // exit can fail — so every request/notify/respond checks this first and fails
    // fast instead of hanging on a dead server.
    let closed: AppServerTransportError | null = null

    // Raw callbacks only offer; `offerUnsafe` is a no-op after scope-close shutdown.
    const lines = createInterface({ input: stdout })
    lines.on("line", (line) => {
      const trimmed = line.trim()
      if (trimmed.length === 0) return
      let msg: unknown
      try {
        msg = JSON.parse(trimmed)
      } catch {
        return // app-server emits only JSON on stdout; stderr is inherited
      }
      if (msg !== null && typeof msg === "object") {
        Queue.offerUnsafe(inbound, { kind: "message", msg: msg as Rec })
      }
    })
    child.on("exit", () => Queue.offerUnsafe(inbound, { kind: "exit" }))
    // A spawn failure (bad command, missing cwd) fires `error`, not `exit`; treat
    // it as an exit so pending requests fail instead of an unhandled throw.
    child.on("error", () => Queue.offerUnsafe(inbound, { kind: "exit" }))
    // Mark the transport closed and fail every in-flight request. Called both
    // when the child's exit is *routed* (process crash while alive) and as a scope
    // finalizer (intentional `stop`): on scope close the drain fiber is
    // interrupted before the child is killed, so the exit event is never routed —
    // without the finalizer a request blocked on `Deferred.await` would hang.
    // Idempotent: whichever runs first clears `pending`, the other finds it empty.
    const failAllPending = () =>
      Effect.gen(function* () {
        closed ??= new AppServerTransportError({ message: `${options.command} exited` })
        for (const [, deferred] of pending) {
          yield* Deferred.fail(deferred, closed)
        }
        pending.clear()
      })

    // Release the readline interface + fail pending requests at scope close,
    // alongside the child kill the acquireRelease above registers.
    yield* Effect.addFinalizer(() => Effect.sync(() => lines.close()))
    yield* Effect.addFinalizer(() => failAllPending())

    const route = (event: Inbound): Effect.Effect<void> =>
      Effect.gen(function* () {
        if (event.kind === "exit") {
          // Fail every in-flight request, mark closed so later calls fail fast, and
          // end both output streams so nobody hangs.
          yield* failAllPending()
          yield* Queue.shutdown(notifications)
          yield* Queue.shutdown(serverRequests)
          return
        }
        const msg = event.msg
        const id = msg["id"] as IdKey | undefined
        const method = msg["method"]
        if (id != null && typeof method !== "string") {
          const deferred = pending.get(id)
          if (!deferred) return
          pending.delete(id)
          if ("error" in msg) {
            const error = msg["error"]
            const detail = typeof error === "object" && error !== null ? error : { message: String(error) }
            yield* Deferred.fail(
              deferred,
              new AppServerTransportError({ message: "app-server request failed", cause: detail }),
            )
          } else {
            yield* Deferred.succeed(deferred, msg["result"])
          }
          return
        }
        if (id != null && typeof method === "string") {
          yield* Queue.offer(serverRequests, { id, method, params: msg["params"] })
          return
        }
        if (typeof method === "string") {
          yield* Queue.offer(notifications, { method, params: msg["params"] })
        }
      })

    yield* Stream.fromQueue(inbound).pipe(Stream.runForEach(route), Effect.forkScoped)

    const writeLine = (payload: Rec): Effect.Effect<void, AppServerTransportError> =>
      Effect.try({
        try: () => {
          stdin.write(`${JSON.stringify(payload)}\n`)
        },
        catch: (cause) => new AppServerTransportError({ message: "write to app-server failed", cause }),
      })

    const request = (method: string, params?: unknown): Effect.Effect<unknown, AppServerTransportError> =>
      Effect.gen(function* () {
        if (closed) return yield* Effect.fail(closed)
        const id = nextId++
        const deferred = yield* Deferred.make<unknown, AppServerTransportError>()
        pending.set(id, deferred)
        // `Deferred.make` yields, so an exit could have drained `pending` between
        // the guard above and here — re-check rather than await a dead deferred.
        if (closed) {
          pending.delete(id)
          return yield* Effect.fail(closed)
        }
        yield* writeLine({ method, id, params: params ?? {} }).pipe(
          Effect.tapError(() => Effect.sync(() => pending.delete(id))),
        )
        return yield* Deferred.await(deferred)
      })

    const notify = (method: string, params?: unknown): Effect.Effect<void, AppServerTransportError> =>
      closed ? Effect.fail(closed) : writeLine({ method, params: params ?? {} })

    const respond = (id: IdKey, result: unknown): Effect.Effect<void, AppServerTransportError> =>
      closed ? Effect.fail(closed) : writeLine({ id, result })

    return {
      request,
      notify,
      respond,
      notifications: Stream.fromQueue(notifications),
      serverRequests: Stream.fromQueue(serverRequests),
    } satisfies AppServerTransport
  })
