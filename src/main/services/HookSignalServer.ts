import { Context, Effect, FiberSet, Layer, Result, Schedule } from "effect"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as net from "node:net"
import { socketPath, toBinding, toSignal } from "../hooks/signals.js"

/**
 * Owns the unix sockets that target CLIs' hooks connect to (one per workspace
 * root). A `SessionStart` helper connects, writes one JSON line, and closes;
 * this server validates it and emits both a raw `signal` and, when possible, a
 * `binding` { targetSessionId, nativeSessionId, … } that main wires into
 * `TargetSessionManager.bindNative`.
 *
 * Mirrors `TargetSessionManager`'s raw `events` EventEmitter (the data plane);
 * the control plane (`ensureListening`) is Effect.
 */
export class HookSignalServer extends Context.Service<
  HookSignalServer,
  {
    /** Idempotent per repoRoot. Resolves with the socket path only once the
     * server is actually listening — so callers can spawn the CLI knowing the
     * channel is up (Codex tightening #1). Never rejects; on bind failure it
     * resolves anyway and logs, so launch is never blocked. */
    readonly ensureListening: (repoRoot: string) => Effect.Effect<string>
    /** raw data plane: emits "signal" HookSignal and "binding" HookBinding */
    readonly events: EventEmitter
  }
>()("HookSignalServer") {}

export const HookSignalServerLive = Layer.effect(
  HookSignalServer,
  Effect.gen(function* () {
    const events = new EventEmitter()
    const servers = new Map<string, net.Server>()

    // The socket callbacks below fire in raw Node event-loop land, outside any
    // Effect fiber. `makeRuntime` captures this layer's context — crucially the
    // OTLP logger merged under the app layers — into a `runFork` we can call from
    // those callbacks, so a dropped-record / socket-error warning reaches the
    // Effect logger (and Lensflare) instead of vanishing into `console`. Forked
    // fibers are interrupted when this layer's scope closes (runtime dispose).
    const runFork = yield* FiberSet.makeRuntime()

    // Sockets are a scoped resource: every server opened by `ensureListening`
    // is closed when this layer's scope closes (i.e. on runtime dispose at app
    // quit). Without this the unix socket nodes leak across runs — the next
    // boot then has to unlink-and-rebind stale paths (see `ensureListening`).
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const server of servers.values()) {
          try {
            server.close()
          } catch {
            /* already closing/closed — nothing to release */
          }
        }
        servers.clear()
      }),
    )

    // One bind attempt: clear a stale socket node, create the server, and listen.
    // Fails with the Node error (which carries `.code`) so the retry below can
    // react to EADDRINUSE; succeeds with the listening server.
    const bindOnce = (sockPath: string) =>
      Effect.callback<net.Server, NodeJS.ErrnoException>((resume) => {
        // Clear a stale socket node left by a previous run, else listen EADDRINUSE.
        try {
          if (fs.existsSync(sockPath)) fs.unlinkSync(sockPath)
        } catch {
          /* fall through; listen will surface any real problem */
        }

        const server = net.createServer((conn) => {
          let buf = ""
          conn.setEncoding("utf8")
          conn.on("data", (d) => {
            buf += d
          })
          conn.on("end", () => {
            for (const line of buf.split("\n")) {
              if (!line.trim()) continue
              const signal = toSignal(line)
              if (Result.isFailure(signal)) {
                runFork(Effect.logWarning(`[arc-hook] dropped record: ${signal.failure.reason}`))
                continue
              }
              events.emit("signal", signal.success)
              const binding = toBinding(line)
              if (Result.isSuccess(binding)) events.emit("binding", binding.success)
            }
          })
          conn.on("error", () => {
            /* a hung/aborted helper connection must not crash main */
          })
        })

        const onBindError = (e: NodeJS.ErrnoException) => {
          server.close()
          resume(Effect.fail(e))
        }
        server.once("error", onBindError)
        server.listen(sockPath, () => {
          server.removeListener("error", onBindError)
          // Past bind, a later socket error must only be logged, never crash main.
          server.on("error", (e) =>
            runFork(Effect.logWarning(`[arc-hook] socket server error (${sockPath}): ${String(e)}`)),
          )
          resume(Effect.succeed(server))
        })
      })

    const ensureListening = (repoRoot: string): Effect.Effect<string> =>
      Effect.suspend(() => {
        const sockPath = socketPath(repoRoot)
        if (servers.has(repoRoot)) return Effect.succeed(sockPath)
        // EADDRINUSE on a quick restart is transient — the prior run's socket may
        // not be released yet. Retry a few times with a short backoff; any other
        // error (or exhausting retries) logs and resolves anyway, so a channel
        // failure never blocks launch.
        return bindOnce(sockPath).pipe(
          Effect.retry({
            while: (e) => e.code === "EADDRINUSE",
            schedule: Schedule.exponential("50 millis").pipe(Schedule.both(Schedule.recurs(3))),
          }),
          Effect.tap((server) => Effect.sync(() => servers.set(repoRoot, server))),
          Effect.as(sockPath),
          Effect.catch((e) =>
            Effect.logWarning(`[arc-hook] socket bind failed (${sockPath}): ${String(e)}`).pipe(
              Effect.as(sockPath),
            ),
          ),
        )
      })

    return { ensureListening, events }
  }),
)
