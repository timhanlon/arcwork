import { Context, Effect, Exit, Layer, Scope } from "effect"
import type {
  CodexAppServerDriver,
  CodexDriverError,
  CodexDriverOptions,
} from "../ingest/providers/codex-appserver/driver.js"
import { launchCodexAppServerSession } from "../ingest/providers/codex-appserver/launch.js"
import { IngestStore } from "../ingest/db/store.js"
import { CodexDriverRegistry } from "./CodexDriverRegistry.js"

/**
 * Launch a resident structured (RPC-backed) session. `command`/`args` come from
 * the provider's app-server capability (e.g. `codex` + `["app-server"]`), mapped
 * in by the caller/router, so this manager stays provider-agnostic.
 */
export interface RpcLaunchRequest {
  readonly chatId: string
  readonly targetSessionId: string
  readonly cwd: string
  readonly command: string
  readonly args: ReadonlyArray<string>
  readonly model?: string
  readonly sandbox?: CodexDriverOptions["sandbox"]
  readonly approvalPolicy?: CodexDriverOptions["approvalPolicy"]
}

/**
 * The runtime owner for **RPC-backed** target sessions — the structured-process
 * sibling of the PTY-backed `TargetSessionManager`. Where that one spawns a
 * pseudo-terminal and drives it with keystrokes/paste/resize, this drives a
 * resident JSON-RPC agent: `submit` runs a turn, approvals flow through the
 * Arc-owned `CodexDriverRegistry` → answer RPC, and there is no byte stream or
 * terminal surface. `TargetSession` identity is unchanged; only the live runtime
 * differs (the renderer branches on session kind for terminal vs transcript).
 *
 * Each session gets a scope forked off the layer scope, so `stop` closes just
 * that session (killing its driver + deregistering its approvals) and app quit
 * closes them all. Today the only RPC driver is codex app-server; pi's rpc mode
 * is the same family and would join here rather than through the PTY machinery.
 */
export class RpcSessionManager extends Context.Service<
  RpcSessionManager,
  {
    /** Launch (idempotent per targetSessionId): spawn the driver, persist its
     * turns, and register its approvals. */
    readonly launch: (req: RpcLaunchRequest) => Effect.Effect<void, CodexDriverError>
    /** Run a user turn against a launched session. `accepted:false` if unknown. */
    readonly submit: (req: {
      readonly targetSessionId: string
      readonly text: string
    }) => Effect.Effect<{ readonly accepted: boolean; readonly status?: string }, CodexDriverError>
    /** Tear a session down: closes its scope (kills driver, deregisters approvals). */
    readonly stop: (targetSessionId: string) => Effect.Effect<{ readonly stopped: boolean }>
    /** The target session ids currently live under this manager. */
    readonly list: Effect.Effect<ReadonlyArray<string>>
  }
>()("arcwork/RpcSessionManager") {}

interface LiveRpcSession {
  readonly driver: CodexAppServerDriver
  readonly scope: Scope.Closeable
}

export const RpcSessionManagerLive = Layer.effect(
  RpcSessionManager,
  Effect.gen(function* () {
    const registry = yield* CodexDriverRegistry
    const ingest = yield* IngestStore
    const parentScope = yield* Effect.scope
    const sessions = new Map<string, LiveRpcSession>()

    const launch = (req: RpcLaunchRequest): Effect.Effect<void, CodexDriverError> =>
      Effect.gen(function* () {
        if (sessions.has(req.targetSessionId)) return // idempotent

        // Child of the layer scope: closes on `stop` or on app quit.
        const scope = yield* Scope.fork(parentScope)
        const build = Effect.gen(function* () {
          const driver = yield* launchCodexAppServerSession(
            { launchCmd: req.command, args: req.args },
            {
              cwd: req.cwd,
              model: req.model,
              sandbox: req.sandbox,
              approvalPolicy: req.approvalPolicy,
            },
          )
          yield* registry.register({
            chatId: req.chatId,
            targetSessionId: req.targetSessionId,
            driver,
          })
          return driver
        }).pipe(Scope.provide(scope), Effect.provideService(IngestStore, ingest))

        const driver = yield* build.pipe(
          // A failed launch must not leak the forked scope (or a half-spawned child).
          Effect.tapError(() => Scope.close(scope, Exit.void)),
        )
        sessions.set(req.targetSessionId, { driver, scope })
      })

    const submit = (req: { readonly targetSessionId: string; readonly text: string }) =>
      Effect.gen(function* () {
        const session = sessions.get(req.targetSessionId)
        if (!session) return { accepted: false as const }
        const result = yield* session.driver.runTurn(req.text)
        return { accepted: true as const, status: result.status }
      })

    const stop = (targetSessionId: string) =>
      Effect.gen(function* () {
        const session = sessions.get(targetSessionId)
        if (!session) return { stopped: false }
        sessions.delete(targetSessionId)
        yield* Scope.close(session.scope, Exit.void)
        return { stopped: true }
      })

    return { launch, submit, stop, list: Effect.sync(() => [...sessions.keys()]) }
  }),
)
