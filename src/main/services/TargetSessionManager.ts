import { Clock, Context, Effect, Layer, Queue, Stream, SubscriptionRef } from "effect"
import * as Semaphore from "effect/Semaphore"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { nowIso } from "../clock.js"
import { EventEmitter } from "node:events"
import type { IPty } from "node-pty"
import type { TargetSession } from "../../shared/instance.js"
import { installProviderHooks } from "../hooks/install.js"
import { HookSignalServer } from "./HookSignalServer.js"
import { ProviderRegistry } from "./ProviderRegistry.js"
import { WorkspaceService } from "./WorkspaceService.js"
import { ChatService } from "./ChatService.js"
import { ArcStore } from "../db/store.js"
import { withSqlOperation } from "../db/sql-operation.js"
import { resolveArcDb } from "../db/paths.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { arcIdOrNull, type ChatId, newArcId } from "../../shared/ids.js"
import { restorePersistedSessions } from "./target-session/boot-restore.js"
import { buildProviderArgs, canResume, resumeArgs } from "./target-session/provider-args.js"
import {
  drivePtySpawn,
  type FirstOutput,
  type PtyExit,
  type SpawnOptions,
} from "./target-session/pty-readiness-driver.js"

/**
 * Owns interactive PTY instances. Sessions are identified by their `target_…`
 * TypeID. Manual launches still reuse a live manual session for the same
 * (chat, provider) as a UX policy; orchestrated launches can create many
 * same-provider sessions in one chat.
 *
 * Control plane (launch/submit/list) is Effect; the byte stream is a raw data
 * plane — PTY output is published on `events` ("data" | "exit"), which the main
 * process forwards to the renderer over IPC. The PTY handle map lives in the
 * Layer closure (not in the Schema'd TargetSession state).
 */

export interface LaunchRequest {
  readonly provider: string
  readonly chatId: ChatId
  readonly origin?: "manual" | "orchestrated"
  /** the orchestrator spawning this session (its target id), for an orchestrated
   * launch — persisted as the durable parent→child back-channel link. */
  readonly spawnedBy?: string
  readonly reuseExisting?: boolean
  /** Diff endpoint to run in; defaults to the chat's own workspace. Letting it
   * differ is what makes the comm/diff cross-product expressible — a worker can
   * talk via one provider while writing into a workspace other than the chat's. */
  readonly workspaceId?: string
  readonly preset?: string
  readonly prompt?: string
  /**
   * Submit the prompt rather than leave it as a draft. The renderer launches a
   * target with a *draft* (the user reviews, then hits Enter) — for providers
   * that prefill via argv (claude) the prompt is seeded but unsent. An
   * autonomous caller (a handoff) sets this so the seeded prompt is also
   * submitted once the session is ready. Providers that already submit on launch
   * (stdin-after-start: cursor, codex) are unaffected.
   */
  readonly autoSubmit?: boolean
  /** Grid size measured by the renderer before launch (see rpc.ts / arc-pty-winsize). */
  readonly cols?: number
  readonly rows?: number
}

export interface SubmitRequest {
  readonly instanceId: string
  readonly text: string
}
export interface ResumeRequest {
  readonly sessionId: string
  readonly cols?: number
  readonly rows?: number
}
export interface StopRequest {
  readonly sessionId: string
}

/**
 * Grace between the polite SIGTERM and the forced SIGKILL. Long enough for an
 * agent CLI to flush/checkpoint on its own SIGTERM handler, short enough that a
 * "stop" the user clicked feels like it took effect.
 */
const STOP_GRACE_MS = 5000

export class TargetSessionManager extends Context.Service<
  TargetSessionManager,
  {
    readonly list: Effect.Effect<ReadonlyArray<TargetSession>>
    /** Reactive view of `list`: emits the current sessions, then every change. */
    readonly changes: Stream.Stream<ReadonlyArray<TargetSession>>
    readonly launch: (
      req: LaunchRequest,
    ) => Effect.Effect<TargetSession, ArcRequestError | SqlError>
    readonly resume: (req: ResumeRequest) => Effect.Effect<TargetSession, ArcRequestError | SqlError>
    /**
     * Stop a running target. Sends SIGTERM, then SIGKILL after {@link STOP_GRACE_MS}
     * if the child hasn't exited. State/DB/broadcast cleanup is left to the
     * child's own `onExit` handler — `stop` only signals. Idempotent: returns
     * `{ stopped: false }` when no live PTY is held for the session.
     */
    readonly stop: (req: StopRequest) => Effect.Effect<{ readonly stopped: boolean }>
    /** Fill a session's `nativeSessionId` once a hook reveals it (Arc-owned
     * session metadata, persisted for resume/debugging/import — not a cross-DB
     * join key). Matches by session `id`; idempotent for the same value. */
    readonly bindNative: (
      targetSessionId: string,
      nativeSessionId: string,
      nativeTranscriptPath?: string | null,
    ) => Effect.Effect<void>
    readonly submit: (req: SubmitRequest) => Effect.Effect<{ readonly accepted: boolean }>
    readonly write: (sessionId: string, data: string) => Effect.Effect<void>
    /** Push a new winsize to a live child (TIOCSWINSZ + SIGWINCH) on window/pane resize. */
    readonly resize: (sessionId: string, cols: number, rows: number) => Effect.Effect<void>
    /** raw data plane: emits "data" {sessionId,data} and "exit" {sessionId,exitCode} */
    readonly events: EventEmitter
  }
>()("TargetSessionManager") {}

export const TargetSessionManagerLive = Layer.effect(
  TargetSessionManager,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry
    const workspaces = yield* WorkspaceService
    const chats = yield* ChatService
    const hookServer = yield* HookSignalServer
    const db = yield* ArcStore
    const scope = yield* Effect.scope

    // Restore persisted sessions on boot (and re-arm their hook sockets); see
    // target-session/boot-restore.ts for the unconfirmed-state reconciliation.
    const initialMap = yield* restorePersistedSessions

    // SubscriptionRef (not Ref) so the session list is observable: `changes`
    // pushes the current value, then every update. This is the Effect-idiomatic
    // reactive store; the renderer mirrors it through an atom. ArcStore is its
    // durable mirror — writes below are awaited (fast synchronous SQLite, and
    // ordered: upsert lands before any bind/state update) but a write *failure*
    // never *fails* the live op.
    const store = yield* SubscriptionRef.make(initialMap)
    const ptys = new Map<string, IPty>()
    // How to deliver a prompt to each live session — paste+Enter for terminal
    // providers, a JSONL command line for rpc providers (pi). Keyed by session id
    // so the inbox/submit path writes the right wire format without re-deriving it.
    const promptWriters = new Map<string, (text: string) => void>()
    const events = new EventEmitter()
    const arcDb = resolveArcDb()

    // Serialize launch/resume so their check-then-spawn windows can't overlap.
    // Both read the store to decide whether a session already exists (manual
    // reuse for the same chat+provider; an already-attached pty on resume) and
    // then spawn — two concurrent RPCs (a double-click, a double resume) would
    // both observe "none" and mint duplicate PTYs into the same session. The
    // critical section is fast (spawn is a synchronous node-pty call; readiness
    // is driven later off callbacks), so one global permit is enough.
    const launchLock = yield* Semaphore.make(1)

    // PTY exit handling runs as structured Effect work, not inline in node-pty's
    // `onExit` callback. The callback only offers the exit notification here; a
    // single scoped fiber (below) drains the queue and applies the whole exit
    // policy — broadcast the renderer exit event, drop the PTY handle, mark the
    // session exited, persist best-effort. This matches the controller's
    // EventEmitter-to-Stream seam and gives exit handling one supervised lifetime
    // and one error policy, instead of a bare `runSync`/`runFork` pair firing
    // from outside the runtime on every child death. (PtyExit/FirstOutput are
    // typed in target-session/pty-readiness-driver.ts, which offers onto these
    // queues from the raw node-pty callbacks.)
    const exits = yield* Queue.make<PtyExit>()

    // First-output observability. The splash banner is the child's very first
    // PTY write; on launch it can race ahead of the `LaunchTarget` RPC that binds
    // the session id in the renderer, so the renderer drops it (Terminal.tsx
    // gates on a known id). To see that race in Lensflare we record, per launch,
    // how long after spawn the first byte arrived and how big that first burst
    // was. Compared against the `arc.target.launch` span (the id round-trip),
    // a first_output latency well below the launch span means the splash lost.
    // Offered from the raw `onData` callback, logged by a scoped Effect fiber.
    const firstOutputs = yield* Queue.make<FirstOutput>()
    yield* Stream.fromQueue(firstOutputs).pipe(
      Stream.runForEach((f) =>
        Effect.gen(function* () {
          const firstByteMs = (yield* Clock.currentTimeMillis) - f.spawnedAt
          yield* Effect.logInfo(
            `target first-output target=${f.sessionId} provider=${f.provider} ` +
              `firstByteMs=${firstByteMs} firstChunkBytes=${f.firstChunkBytes}`,
          ).pipe(
            Effect.annotateLogs({
              "arc.event": "target.first_output",
              "arc.provider": f.provider,
              "arc.target_session_id": f.sessionId,
              "arc.first_byte_ms": firstByteMs,
              "arc.first_chunk_bytes": f.firstChunkBytes,
            }),
          )
        }),
      ),
      Effect.forkScoped,
    )
    const handleExit = ({ sessionId, exitCode }: PtyExit) =>
      Effect.logInfo(`target exited target=${sessionId} code=${exitCode}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            events.emit("exit", { sessionId, exitCode })
            ptys.delete(sessionId)
            promptWriters.delete(sessionId)
          }),
        ),
      ).pipe(
        Effect.andThen(
          SubscriptionRef.update(store, (m) => {
            const next = new Map(m)
            const session = next.get(sessionId)
            if (session) next.set(sessionId, { ...session, state: "exited" })
            return next
          }),
        ),
        Effect.andThen(
          db
            .setTargetSessionState(sessionId, "exited")
            .pipe(
              Effect.tapError((e) => Effect.logWarning(`exit persist failed (${sessionId}): ${e}`)),
              Effect.ignore,
            ),
        ),
      )
    yield* Stream.fromQueue(exits).pipe(Stream.runForEach(handleExit), Effect.forkScoped)

    // Shutdown policy: on runtime dispose (app quit) KILL every live child PTY.
    // agent CLIs are launched by and scoped to arc — we do not leave orphaned
    // processes behind. We do not persist "exited" here: a hard kill races the
    // child's own `onExit`, and a half-written state is worse than none. The
    // persisted row stays "running" and is reconciled to "unknown" on next boot
    // (see the restore logic above), which is the honest post-crash state.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const child of ptys.values()) {
          try {
            child.kill()
          } catch {
            /* child already gone — nothing to release */
          }
        }
        ptys.clear()
      }),
    )

    const persistSession = (s: TargetSession) =>
      db
        .upsertTargetSession({
          id: s.id,
          chatId: s.chatId,
          provider: s.provider,
          origin: s.origin ?? "manual",
          spawnedBy: s.spawnedBy ?? null,
          preset: s.preset ?? null,
          cwd: s.cwd,
          nativeSessionId: s.nativeSessionId ?? null,
          nativeTranscriptPath: s.nativeTranscriptPath ?? null,
          state: s.state,
          startedAt: s.startedAt,
        })
        .pipe(
          // Name this work on the SQLite acquire span: on the launch path this
          // single-row upsert is the statement that waits behind the ingest
          // reprojection holder, so the wait records `blocked_by` against it.
          withSqlOperation("arc.target.persist", { targetSessionId: s.id }),
          Effect.tapError((e) => Effect.logWarning(`session persist failed (${s.id}): ${e}`)),
          Effect.ignore,
        )

    const asList = (m: ReadonlyMap<string, TargetSession>): ReadonlyArray<TargetSession> =>
      Array.from(m.values()).map((s) => ({
        ...s,
        attached: ptys.has(s.id),
        resumable: canResume(s),
      }))
    const list = SubscriptionRef.get(store).pipe(Effect.map(asList))
    const changes = Stream.map(SubscriptionRef.changes(store), asList)

    // Spawn the child PTY and wire its terminal-protocol lifecycle. The driver is
    // a synchronous side-effecting function over the live closure handles
    // (ptys/promptWriters/events + the two queues); see
    // target-session/pty-readiness-driver.ts.
    const spawnAttached = (session: TargetSession, opts: SpawnOptions) =>
      Effect.gen(function* () {
        const spawnedAt = yield* Clock.currentTimeMillis
        yield* Effect.sync(() =>
          drivePtySpawn(
            { ptys, promptWriters, events, firstOutputs, exits, dbPath: arcDb.dbPath },
            session,
            opts,
            spawnedAt,
          ),
        )
      })

    const launch = (req: LaunchRequest) =>
      launchLock.withPermits(1)(
      Effect.gen(function* () {
        const origin = req.origin ?? "manual"
        const reuseExisting = req.reuseExisting ?? origin === "manual"

        const spec = yield* registry.get(req.provider)
        if (!spec?.interactive) {
          return yield* Effect.fail(
            arcRequestError(`Provider "${req.provider}" has no interactive capability`),
          )
        }
        const cap = spec.interactive

        const chat = yield* chats.get(req.chatId)
        const wsList = yield* workspaces.list
        const wsId = req.workspaceId ?? chat.workspaceId
        const ws = wsList.find((w) => w.id === wsId)
        if (!ws) {
          return yield* Effect.fail(
            arcRequestError(`Unknown workspace "${wsId}" for chat "${req.chatId}"`),
          )
        }
        const cwd = ws.path

        const current = yield* SubscriptionRef.get(store)
        const existing = reuseExisting
          ? Array.from(current.values())
              .filter((s) => s.chatId === req.chatId && s.provider === req.provider && (s.origin ?? "manual") === "manual")
              .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0]
          : undefined
        // Manual launch keeps the old convenience policy: reuse the live default
        // provider session for this chat. This is a secondary lookup, not
        // identity; orchestrated launches skip it and mint a fresh TypeID.
        if (existing && ptys.has(existing.id)) {
          if (existing.cwd !== cwd) {
            return yield* Effect.fail(
              arcRequestError(
                `Chat "${req.chatId}" already has a live ${req.provider} session in ${existing.cwd}; ` +
                  `stop it before launching into ${cwd}`,
              ),
            )
          }
          return existing
        }
        const id = reuseExisting && existing ? existing.id : newArcId("target")

        // Arm native-session capture BEFORE spawn: bring the hook socket up (so
        // the channel is live the instant the child's SessionStart fires), then
        // install the hook config. Install is best-effort but logged — a failure
        // only means hook signals stay unavailable, never a blocked launch.
        const sockPath = yield* hookServer.ensureListening(cwd).pipe(
          Effect.withSpan("arc.target.hook_ensure", {
            attributes: { "arc.workspace": cwd, "arc.provider": req.provider },
          }),
        )
        const result = yield* installProviderHooks(cwd, req.provider).pipe(
          Effect.withSpan("arc.target.hook_install", {
            attributes: { "arc.workspace": cwd, "arc.provider": req.provider },
          }),
        )
        if (!result.installed) {
          yield* Effect.logWarning(
            `hook install failed for ${req.provider} in ${cwd}; hook signals unavailable: ${result.reason}`,
          )
        }
        // Provider integration argv (hooks + MCP), all Arc-owned and repo-clean.
        // cursor: one `--plugin-dir` plugin bundles its hooks + MCP. claude/codex:
        // declare the arc MCP server inline (`--mcp-config`/`-c`). The MCP argv
        // leads so codex's global `-c` sits before any subcommand.
        const args: Array<string> = yield* buildProviderArgs(req.provider, {
          chatId: req.chatId,
          targetSessionId: id,
          cwd,
          model: req.preset ?? undefined,
        })
        let writeAfterStart: string | undefined
        let seededViaPrefill = false
        const extraEnv: Record<string, string> = {}
        if (req.prompt) {
          if (cap.draftPromptFlag) {
            args.push(cap.draftPromptFlag, req.prompt)
            seededViaPrefill = true
          } else if (cap.draftPromptEnvVar) {
            extraEnv[cap.draftPromptEnvVar] = req.prompt
            seededViaPrefill = true
          } else {
            writeAfterStart = req.prompt // stdin-after-start (submits on its own)
          }
        }
        // An autonomous caller wants the work actually started: submit the seeded
        // prompt once ready. (stdin-after-start already submitted, so nothing to add.)
        const submitSeededAfterReady = req.autoSubmit === true && seededViaPrefill

        // Spawn at the renderer-measured grid size so the child's FIRST winsize
        // read is correct. A later resize cannot fix it (Ink can't reflow
        // scrollback). Fall back to
        // 80x24 only for callers that never measured (e.g. headless).
        const session: TargetSession = {
          _tag: "TargetSession",
          id,
          provider: req.provider,
          origin,
          spawnedBy: arcIdOrNull("target", req.spawnedBy) ?? undefined,
          preset: req.preset,
          chatId: req.chatId,
          cwd,
          // Carry forward the previous binding (from a restored/exited row) until
          // this fresh child's SessionStart hook rebinds. Spawning mints a new
          // native session, but until the hook arrives the last-known id is the
          // best we have — never null it out, or a late/failed hook would erase
          // exactly the binding this store exists to preserve.
          nativeSessionId: existing?.nativeSessionId,
          nativeTranscriptPath: existing?.nativeTranscriptPath,
          attached: true,
          state: "running",
          startedAt: yield* nowIso,
        }
        yield* spawnAttached(session, {
          launchCmd: cap.launchCmd,
          args,
          cols: req.cols,
          rows: req.rows,
          sockPath,
          writeAfterStart,
          extraEnv,
          submitSeededAfterReady,
          readyGlyph: cap.readyPromptGlyph,
          promptInjectionMode: cap.promptInjectionMode,
          advanceGates: cap.advanceGates,
        }).pipe(
          Effect.withSpan("arc.target.spawn", {
            attributes: { "arc.provider": req.provider, "arc.target_session_id": id },
          }),
        )
        yield* SubscriptionRef.update(store, (m) => new Map(m).set(session.id, session))
        // persistSession already names its SQLite span "arc.target.persist" via
        // withSqlOperation, so no outer withSpan is needed here.
        yield* persistSession(session)
        yield* Effect.logInfo(
          `target launched provider=${session.provider} chat=${session.chatId} target=${session.id}`,
        )
        return session
      }).pipe(
        Effect.withSpan("arc.target.launch", {
          attributes: { "arc.provider": req.provider, "arc.chat_id": req.chatId },
        }),
      ),
      )

    const resume = (req: ResumeRequest) =>
      launchLock.withPermits(1)(
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(store)
        const existing = current.get(req.sessionId)
        if (!existing) {
          return yield* Effect.fail(arcRequestError(`Unknown target session "${req.sessionId}"`))
        }
        if (ptys.has(existing.id)) return { ...existing, attached: true }

        const spec = yield* registry.get(existing.provider)
        if (!spec?.interactive) {
          return yield* Effect.fail(
            arcRequestError(`Provider "${existing.provider}" has no interactive capability`),
          )
        }
        if (!canResume(existing)) {
          return yield* Effect.fail(
            arcRequestError(`Target session "${existing.id}" has no resumable native session`),
          )
        }
        const resumeBase = resumeArgs(existing.provider, existing.nativeSessionId)
        if (!resumeBase) {
          return yield* Effect.fail(arcRequestError(`Target session "${existing.id}" has no native session id to resume`))
        }

        const sockPath = yield* hookServer.ensureListening(existing.cwd)
        const result = yield* installProviderHooks(existing.cwd, existing.provider)
        if (!result.installed) {
          yield* Effect.logWarning(
            `resume hook install failed for ${existing.provider} in ${existing.cwd}; hook signals unavailable: ${result.reason}`,
          )
        }

        // Hooks/MCP aren't persisted in a repo file, so resume re-declares them
        // exactly like launch (cursor plugin / inline argv). Integration argv
        // leads so codex's global `-c` sits before the `resume` subcommand.
        const args = [
          ...(yield* buildProviderArgs(existing.provider, {
            chatId: existing.chatId,
            targetSessionId: existing.id,
            cwd: existing.cwd,
            model: existing.preset ?? undefined,
          })),
          ...resumeBase,
        ]

        const session: TargetSession = { ...existing, attached: true, state: "running" }
        // No seeded prompt on resume (writeAfterStart/submitSeededAfterReady left
        // at defaults), but pass the injection mode so the prompt writer is
        // registered — a later inbox send must reach the resumed session.
        yield* spawnAttached(session, {
          launchCmd: spec.interactive.launchCmd,
          args,
          cols: req.cols,
          rows: req.rows,
          sockPath,
          readyGlyph: spec.interactive.readyPromptGlyph,
          promptInjectionMode: spec.interactive.promptInjectionMode,
          advanceGates: spec.interactive.advanceGates,
        })
        yield* SubscriptionRef.update(store, (m) => new Map(m).set(session.id, session))
        yield* persistSession(session)
        yield* Effect.logInfo(
          `target resumed provider=${session.provider} chat=${session.chatId} target=${session.id}`,
        )
        return session
      }),
      )

    // Stop a live child on demand. The same kill the app-quit finalizer does,
    // but for one session and graceful: SIGTERM first so the agent CLI can
    // flush, then SIGKILL after the grace window if it ignored the signal. We
    // touch neither `store` nor the DB here — the child's `onExit` handler
    // (set in spawnAttached) already deletes the pty, flips state to "exited",
    // persists, and broadcasts. A session with no live pty (already exited or
    // detached) is a no-op, so stop is safe to call twice.
    const stop = (req: StopRequest) =>
      Effect.gen(function* () {
        const child = ptys.get(req.sessionId)
        if (!child) return { stopped: false }
        yield* Effect.logInfo(`target stop requested target=${req.sessionId}`)
        yield* Effect.try({ try: () => child.kill("SIGTERM"), catch: () => undefined }).pipe(Effect.ignore)
        yield* Effect.sleep(STOP_GRACE_MS).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              ptys.get(req.sessionId) !== child
                ? Effect.void
                : Effect.try({ try: () => child.kill("SIGKILL"), catch: () => undefined }).pipe(Effect.ignore),
            ),
          ),
          Effect.forkIn(scope),
        )
        return { stopped: true }
      }).pipe(
        Effect.withSpan("arc.target.stop", {
          attributes: { "arc.target_session_id": req.sessionId },
        }),
      )

    const bindNative = (
      targetSessionId: string,
      nativeSessionId: string,
      nativeTranscriptPath?: string | null,
    ) =>
      Effect.gen(function* () {
        const current = yield* SubscriptionRef.get(store)
        const session = current.get(targetSessionId)
        if (!session) {
          // A signal for a target we don't (or no longer) track — validates the
          // "known live target" check (Codex tightening #3) without mutating.
          yield* Effect.logWarning(`hook binding for unknown target ${targetSessionId}; ignored`)
          return
        }
        if (session.nativeSessionId === nativeSessionId && (!nativeTranscriptPath || session.nativeTranscriptPath === nativeTranscriptPath)) {
          return // idempotent
        }
        if (session.nativeSessionId) {
          // Rebind (e.g. resume/compaction minted a new native id). Allowed,
          // but logged so provider identity changes stay visible during the spike.
          yield* Effect.logInfo(
            `native session changed target=${targetSessionId} provider=${session.provider} chat=${session.chatId} old=${session.nativeSessionId} new=${nativeSessionId}`,
          )
        }
        // Re-read the session from the map inside `update`, not from the snapshot
        // above: `handleExit` may have flipped it to "exited" while this effect
        // yielded through the log/guard steps. Spreading the captured `session`
        // would resurrect its "running" state; spread the latest so only the
        // native-binding fields change (and drop the write if it vanished).
        yield* SubscriptionRef.update(store, (m) => {
          const latest = m.get(targetSessionId)
          if (!latest) return m
          return new Map(m).set(latest.id, {
            ...latest,
            nativeSessionId,
            nativeTranscriptPath: nativeTranscriptPath ?? latest.nativeTranscriptPath,
          })
        })
        // Persist the binding so it survives restart (the whole point of this
        // arc) — awaited, but a write failure never fails the live mutation above.
        yield* db
          .setNativeSessionId(targetSessionId, nativeSessionId, nativeTranscriptPath)
          .pipe(
            Effect.tapError((e) => Effect.logWarning(`binding persist failed (${targetSessionId}): ${e}`)),
            Effect.ignore,
          )
      })

    const submit = (req: SubmitRequest) =>
      Effect.sync(() => {
        const write = promptWriters.get(req.instanceId)
        if (!write) return { accepted: false } // no live child to accept the prompt
        write(req.text)
        return { accepted: true }
      })

    const write = (sessionId: string, data: string) =>
      Effect.sync(() => {
        ptys.get(sessionId)?.write(data)
      })

    const resize = (sessionId: string, cols: number, rows: number) =>
      Effect.sync(() => {
        if (cols <= 0 || rows <= 0) return
        ptys.get(sessionId)?.resize(Math.floor(cols), Math.floor(rows))
      })

    return { list, changes, launch, resume, stop, bindNative, submit, write, resize, events }
  }),
)
