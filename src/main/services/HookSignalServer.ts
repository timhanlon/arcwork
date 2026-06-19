import { Context, Effect, FiberSet, Layer } from "effect"
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

    const ensureListening = (repoRoot: string) =>
      Effect.promise(
        () =>
          new Promise<string>((resolve) => {
            const sockPath = socketPath(repoRoot)
            if (servers.has(repoRoot)) {
              resolve(sockPath)
              return
            }
            let settled = false
            const done = (): void => {
              if (settled) return
              settled = true
              resolve(sockPath)
            }

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
                  if (signal.ok) events.emit("signal", signal.signal)
                  else {
                    runFork(Effect.logWarning(`[arc-hook] dropped record: ${signal.reason}`))
                    continue
                  }
                  const binding = toBinding(line)
                  if (binding.ok) events.emit("binding", binding.binding)
                }
              })
              conn.on("error", () => {
                /* a hung/aborted helper connection must not crash main */
              })
            })

            server.on("error", (e) => {
              runFork(Effect.logWarning(`[arc-hook] socket server error (${sockPath}): ${String(e)}`))
              done() // do not block launch on a channel failure
            })

            server.listen(sockPath, () => {
              servers.set(repoRoot, server)
              done()
            })
          }),
      )

    return { ensureListening, events }
  }),
)
