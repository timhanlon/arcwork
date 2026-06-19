import { Clock, Effect, FiberMap, Queue, Schedule, type Scope, Stream } from "effect"
import type { EventEmitter } from "node:events"
import * as fs from "node:fs"
import { ipcMain } from "electron"
import type { TargetSession } from "../../shared/instance.js"
import { TargetSessionManager } from "./TargetSessionManager.js"
import { HookSignalServer } from "./HookSignalServer.js"
import { ActivityEventService } from "./ActivityEventService.js"
import { ChatMessageService } from "./ChatMessageService.js"
import { LiveTargetStateService } from "./LiveTargetStateService.js"
import { RawHookSignalService } from "./RawHookSignalService.js"
import { ArtifactIngestService } from "./ArtifactIngestService.js"
import { ingestHookSignal } from "./HookSignalIngestion.js"
import { WorkService } from "../work/service.js"
import {
  commitCitationNote,
  commitFromSignal,
  isCommitSignal,
  pickWorkForCommit,
} from "../hooks/commit.js"
import { turnLifecycle } from "../hooks/turn-lifecycle.js"
import type { Provider } from "../ingest/db/schema.js"
import type { HookBinding, HookSignal } from "../hooks/signals.js"
import { hookSignalToAssistantStreamDelta } from "../hooks/assistant-stream-delta.js"
import { PTY_TRACE_ENABLED, tracePtySend } from "./pty-trace.js"

/** How the controller reaches renderer windows. The Electron implementation
 * lives at the bootstrap boundary (`index.ts`); the controller stays unaware of
 * `BrowserWindow`. */
export type Broadcast = (channel: string, payload: unknown) => void
export interface RendererTransport {
  /** Send a payload to every open renderer window. */
  readonly broadcast: Broadcast
}


const ARTIFACT_POLL_INTERVAL = "750 millis"
const TRANSCRIPT_WATCH_DEBOUNCE = "200 millis"
// `fs.watchFile`'s stat-poll cadence for the single bound transcript. The
// coalescing `debounce` above still collapses a write burst into one ingest, so
// this only bounds worst-case live latency, not ingest frequency.
const TRANSCRIPT_POLL_INTERVAL_MS = 1000

const shouldBackfillArtifacts = (signal: HookSignal): boolean => {
  const event = signal.declaredEvent.toLowerCase()
  return event === "stop" || event === "sessionend" || event === "session_end"
}

const shouldPollArtifacts = (signal: HookSignal): boolean => {
  const event = signal.declaredEvent.toLowerCase()
  return signal.provider === "cursor" && event === "beforesubmitprompt"
}

/** Scope a backfill to the signal's provider when it's one we recognize, so we
 * don't parse the other providers' transcripts on a turn-end. Unknown providers
 * fall back to sweeping all. */
const KNOWN_PROVIDERS = new Set<string>(["claude", "codex", "cursor"])
const providerFilter = (signal: HookSignal): Provider | "all" =>
  KNOWN_PROVIDERS.has(signal.provider) ? (signal.provider as Provider) : "all"

const transcriptPathToWatch = (session: TargetSession): string | undefined =>
  session.attached === true && session.state !== "exited" && session.nativeSessionId
    ? session.nativeTranscriptPath
    : undefined

/** Adapt a raw Node `EventEmitter` channel into a scoped `Stream`: the listener
 * is attached on subscribe and removed by the stream's finalizer, so consuming
 * it under `Effect.forkScoped` gives deterministic listener cleanup for free. */
const streamFromEmitter = <A>(emitter: EventEmitter, event: string): Stream.Stream<A> =>
  Stream.callback<A>((queue) =>
    Effect.gen(function* () {
      const listener = (payload: A): void => {
        Queue.offerUnsafe(queue, payload)
      }
      emitter.on(event, listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          emitter.off(event, listener)
        }),
      )
    }),
    // Hook signals are low-frequency; a generous buffer avoids dropping a burst
    // (e.g. a Stop that fans out to several drafts) while the consumer catches up.
    { bufferSize: 1024 },
  )

interface TranscriptChange {
  readonly session: TargetSession
  readonly eventType: string
  readonly filename: string | null
  readonly size: number | null
  readonly mtimeMs: number | null
}

const fileStats = (path: string): { readonly size: number | null; readonly mtimeMs: number | null } => {
  try {
    const stat = fs.statSync(path)
    return { size: stat.size, mtimeMs: stat.mtimeMs }
  } catch {
    return { size: null, mtimeMs: null }
  }
}

const watchTranscript = (session: TargetSession): Stream.Stream<TranscriptChange> =>
  Stream.callback<TranscriptChange>((queue) =>
    Effect.gen(function* () {
      const transcriptPath = session.nativeTranscriptPath
      if (!transcriptPath) return
      // `fs.watchFile` (stat polling) follows the *path*, not the inode. That
      // matters because `fs.watch` goes permanently silent after the first
      // event when a provider rewrites the transcript via temp-file + rename
      // (Codex does this) — the watched inode is replaced and no further change
      // is reported. Polling also fires the moment the file first appears,
      // closing the start-before-create race that previously aborted the
      // watcher outright. Scoped to the one bound transcript, so it is far
      // cheaper than the workspace-wide poll this watcher descends from.
      const listener = (curr: fs.Stats, prev: fs.Stats): void => {
        if (curr.mtimeMs === prev.mtimeMs && curr.size === prev.size) return
        Queue.offerUnsafe(queue, {
          session,
          eventType: "change",
          filename: null,
          size: curr.size,
          mtimeMs: curr.mtimeMs,
        })
      }
      fs.watchFile(transcriptPath, { interval: TRANSCRIPT_POLL_INTERVAL_MS }, listener)
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          fs.unwatchFile(transcriptPath, listener)
        }),
      )
    }),
    { bufferSize: 1024 },
  )

/**
 * The single scoped owner of the main process's long-lived orchestration.
 *
 * Everything created here is tied to the controller's `Scope`: IPC handlers,
 * raw PTY/hook event listeners, the reactive broadcast fibers, and the
 * per-target artifact pollers. Closing the scope (on app quit) removes the IPC
 * handlers and listeners, interrupts every fiber, and cancels every poller —
 * nothing leaks across runtime shutdown. PTY children and hook sockets are
 * owned by their respective services and released through the same runtime
 * dispose.
 *
 * `runFork` is the deliberate bridge from the raw data plane (synchronous
 * `ipcMain` keystroke/resize events, which by design sit outside Effect) into
 * the typed services; the effects it runs are instantaneous `Effect.sync`
 * writes, not supervised work.
 */
export const launchArcMainController = (
  transport: RendererTransport,
  runFork: <A, E>(effect: Effect.Effect<A, E>) => unknown,
): Effect.Effect<
  void,
  never,
  | Scope.Scope
  | TargetSessionManager
  | HookSignalServer
  | RawHookSignalService
  | ActivityEventService
  | ChatMessageService
  | LiveTargetStateService
  | ArtifactIngestService
  | WorkService
> =>
  Effect.gen(function* () {
    const sessions = yield* TargetSessionManager
    const hookServer = yield* HookSignalServer
    const rawHookSignals = yield* RawHookSignalService
    const activityEvents = yield* ActivityEventService
    const chatMessages = yield* ChatMessageService
    const liveStates = yield* LiveTargetStateService
    const artifactIngest = yield* ArtifactIngestService
    const work = yield* WorkService

    // Per-target artifact pollers. A FiberMap is a scoped resource: each poller
    // is keyed by target session id, replacing or removing one interrupts its
    // fiber, and scope close interrupts them all — pollers cannot leak, nor can
    // a poller outlive the target session that started it.
    const pollers = yield* FiberMap.make<string>()
    const transcriptWatchers = yield* FiberMap.make<string>()
    // target id -> the transcript path currently being watched. Tracking the
    // path (not just presence) lets a resume/compaction rebind — which mints a
    // new native session and transcript file — restart the watcher on the new
    // file instead of tailing the dead one.
    const watchedTargets = new Map<string, string>()

    const providerForSession = (session: TargetSession): Provider | "all" =>
      KNOWN_PROVIDERS.has(session.provider) ? (session.provider as Provider) : "all"

    const observabilityPayload = (
      session: TargetSession,
      extra: Record<string, unknown> = {},
    ): Record<string, unknown> => ({
      chatId: session.chatId,
      targetSessionId: session.id,
      provider: session.provider,
      nativeSessionId: session.nativeSessionId,
      nativeTranscriptPath: session.nativeTranscriptPath,
      ...extra,
    })

    const recordControllerEvent = (
      session: TargetSession,
      kind: string,
      extra: Record<string, unknown> = {},
    ) =>
      activityEvents.record({
        workspaceRoot: session.cwd,
        chatId: session.chatId,
        targetSessionId: session.id,
        source: "controller",
        kind,
        actor: session.provider,
        payload: observabilityPayload(session, extra),
      })

    const ingestForSession = (
      session: TargetSession,
      trigger: string,
      extra: Record<string, unknown> = {},
    ) =>
      Effect.gen(function* () {
        yield* recordControllerEvent(session, "ingest_requested", { trigger, ...extra })
        const started = yield* Clock.currentTimeMillis
        yield* recordControllerEvent(session, "ingest_started", { trigger, ...extra })
        const result = yield* Effect.result(
          artifactIngest.ingestWorkspace(
            session.cwd,
            providerForSession(session),
            session.nativeSessionId ?? undefined,
          ),
        )
        const durationMs = (yield* Clock.currentTimeMillis) - started
        if (result._tag === "Failure") {
          yield* recordControllerEvent(session, "ingest_failed", {
            trigger,
            durationMs,
            error: String(result.failure),
            ...extra,
          })
          return
        }
        yield* recordControllerEvent(session, "ingest_finished", {
          trigger,
          durationMs,
          summaries: result.success,
          ...extra,
        })
      })

    const runTranscriptWatcher = (session: TargetSession) =>
      Effect.gen(function* () {
        const transcriptPath = session.nativeTranscriptPath
        if (!transcriptPath || !session.nativeSessionId) return
        const exists = fs.existsSync(transcriptPath)
        const stats = fileStats(transcriptPath)
        yield* recordControllerEvent(session, "watch_started", {
          trigger: "target_bound",
          size: stats.size,
          mtimeMs: stats.mtimeMs,
          exists,
        })
        // Reconcile now when the transcript is already on disk; otherwise the
        // watchFile poll below picks it up the moment the provider creates it,
        // so a start-before-create race no longer drops the watcher.
        if (exists) {
          yield* ingestForSession(session, "startup_reconcile", { size: stats.size, mtimeMs: stats.mtimeMs })
        }
        yield* watchTranscript(session).pipe(
          Stream.tap((change) =>
            recordControllerEvent(session, "watch_changed", {
              eventType: change.eventType,
              filename: change.filename,
              size: change.size,
              mtimeMs: change.mtimeMs,
            }),
          ),
          Stream.debounce(TRANSCRIPT_WATCH_DEBOUNCE),
          Stream.tap((change) =>
            recordControllerEvent(session, "watch_debounced", {
              eventType: change.eventType,
              filename: change.filename,
              size: change.size,
              mtimeMs: change.mtimeMs,
            }),
          ),
          Stream.runForEach((change) =>
            ingestForSession(session, "transcript_watch", {
              eventType: change.eventType,
              filename: change.filename,
              size: change.size,
              mtimeMs: change.mtimeMs,
            }),
          ),
        )
      }).pipe(
        Effect.catchCause((cause) =>
          recordControllerEvent(session, "watch_error", {
            trigger: "watch_stream",
            error: String(cause),
          }),
        ),
        Effect.ensuring(recordControllerEvent(session, "watch_stopped", { trigger: "watcher_scope_closed" })),
      )

    const pollArtifacts = (signal: HookSignal) =>
      signal.cwd
        ? artifactIngest
            // Scope each tick to the provider and the single active session, the
            // same way the Stop/backfill branch does (see below). Without the
            // native id this re-persisted every session in the workspace on a
            // 750ms loop for the whole interaction — re-pegging the main process
            // inside better-sqlite3 even after the parse-once fix (f6c0103). The
            // poll only needs the session being interacted with; the rest aren't
            // changing. Falls back to the full provider sweep when the id is
            // absent (`?? undefined`), so a missing id never stops ingest.
            .ingestWorkspace(signal.cwd, providerFilter(signal), signal.native.sessionId ?? undefined)
            .pipe(Effect.repeat(Schedule.spaced(ARTIFACT_POLL_INTERVAL)))
        : Effect.void

    // --- Control plane: the typed RPC seam is owned by the RpcServer started in
    // the runtime layer (see rpc-transport.ts / runtime.ts); the controller no
    // longer registers it. ---

    // --- Data plane: forward PTY output to renderers; accept raw keystrokes. ---
    // Kept as direct synchronous listeners (the byte stream is intentionally not
    // routed through Effect), with finalizers for deterministic removal.
    const onPtyData = (evt: unknown): void => {
      const e = evt as { sessionId?: string; data?: string }
      if (PTY_TRACE_ENABLED && typeof e.sessionId === "string" && typeof e.data === "string") {
        tracePtySend(e.sessionId, e.data)
      }
      transport.broadcast("arc:pty-data", evt)
    }
    const onPtyExit = (evt: unknown): void => transport.broadcast("arc:pty-exit", evt)
    sessions.events.on("data", onPtyData)
    sessions.events.on("exit", onPtyExit)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        sessions.events.off("data", onPtyData)
        sessions.events.off("exit", onPtyExit)
      }),
    )

    const onPtyWrite = (_event: unknown, { sessionId, data }: { sessionId: string; data: string }): void => {
      runFork(sessions.write(sessionId, data))
    }
    const onPtyResize = (
      _event: unknown,
      { sessionId, cols, rows }: { sessionId: string; cols: number; rows: number },
    ): void => {
      runFork(sessions.resize(sessionId, cols, rows))
    }
    // Observability: the renderer reports PTY bytes that arrived for a session
    // before its id bound and were recovered — buffered, then replayed into the
    // terminal on bind (the splash banner that used to be lost). Logged via
    // Effect so it lands in Lensflare alongside the main-side
    // `arc.target.first_output` timing.
    const onPtyReplayed = (
      _event: unknown,
      { sessionId, bytes, chunks }: { sessionId: string; bytes: number; chunks: number },
    ): void => {
      runFork(
        Effect.logInfo(
          `target output replayed on id-bind target=${sessionId} bytes=${bytes} chunks=${chunks}`,
        ).pipe(
          Effect.annotateLogs({
            "arc.event": "pty.replayed",
            "arc.target_session_id": sessionId,
            "arc.replayed_bytes": bytes,
            "arc.replayed_chunks": chunks,
          }),
        ),
      )
    }
    // The renderer reports PTY bytes genuinely lost before id-bind — output that
    // overflowed the pre-bind replay buffer's cap (healthy launches report none).
    const onPtyDropped = (
      _event: unknown,
      { sessionId, bytes, chunks }: { sessionId: string; bytes: number; chunks: number },
    ): void => {
      runFork(
        Effect.logWarning(
          `target output dropped before id-bind target=${sessionId} bytes=${bytes} chunks=${chunks}`,
        ).pipe(
          Effect.annotateLogs({
            "arc.event": "pty.dropped",
            "arc.target_session_id": sessionId,
            "arc.dropped_bytes": bytes,
            "arc.dropped_chunks": chunks,
          }),
        ),
      )
    }
    ipcMain.on("arc:pty-write", onPtyWrite)
    ipcMain.on("arc:pty-resize", onPtyResize)
    ipcMain.on("arc:pty-replayed", onPtyReplayed)
    ipcMain.on("arc:pty-dropped", onPtyDropped)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        ipcMain.removeListener("arc:pty-write", onPtyWrite)
        ipcMain.removeListener("arc:pty-resize", onPtyResize)
        ipcMain.removeListener("arc:pty-replayed", onPtyReplayed)
        ipcMain.removeListener("arc:pty-dropped", onPtyDropped)
      }),
    )

    // --- Hook signals (control plane): supervised stream consumers. ---
    // A hook revealed a child's native session id — bind it onto the session.
    // The mutation flows to renderers through the `changes` broadcasts below.
    yield* streamFromEmitter<HookBinding>(hookServer.events, "binding").pipe(
      Stream.runForEach((b) => sessions.bindNative(b.targetSessionId, b.nativeSessionId, b.transcriptPath)),
      Effect.forkScoped,
    )

    // A git `post-commit` signal (shipped by `.githooks/post-commit` from an
    // arc-stamped shell) carries the commit's chat context for free. Stamp a
    // typed `commit` citation onto the work that chat is plausibly progressing —
    // the structured replacement for hand-written "Committed as <sha>" notes.
    // Best-effort: a commit from a chat with no work, or any failure, leaves the
    // commit as a repo-level raw signal with no citation, which is correct.
    const stampCommitCitation = (signal: HookSignal) =>
      Effect.gen(function* () {
        const commit = commitFromSignal(signal)
        const chatId = signal.arc.chatId
        if (!commit || !chatId) return
        const works = yield* work.listForChat(chatId)
        const target = pickWorkForCommit(works)
        if (!target) return
        yield* work.addCitation(
          target.id,
          { kind: "commit", target: commit.sha, note: commitCitationNote(commit) },
          { source: "git-hook", chatId, sessionId: signal.arc.targetSessionId ?? undefined },
        )
      }).pipe(
        Effect.tapError((e) => Effect.logWarning(`commit citation stamp failed: ${String(e)}`)),
        Effect.ignore,
      )

    // Persist/project each signal, then drive artifact polling: providers that
    // can't backfill on Stop (cursor) get polled while a turn is open; a
    // terminal event backfills once and stops that target's poller.
    yield* streamFromEmitter<HookSignal>(hookServer.events, "signal").pipe(
      Stream.runForEach((signal) =>
        Effect.gen(function* () {
          // Live assistant tokens are render-only: forward them straight to the
          // ephemeral StreamingMessage and skip persistence. The durable bubble
          // arrives via the transcript backfill/watcher (artifact projection).
          const delta = hookSignalToAssistantStreamDelta(signal)
          if (delta?.targetSessionId) {
            transport.broadcast("arc:assistant-stream", delta)
          }
          yield* ingestHookSignal(
            { raw: rawHookSignals, activity: activityEvents, chat: chatMessages },
            signal,
          )
          // Commit signals don't drive the chat/turn projections below; they
          // resolve to a typed citation on the chat's work and then stop here.
          if (isCommitSignal(signal)) {
            yield* stampCommitCitation(signal)
            return
          }
          // Drive the live "generating" activity: a prompt submit opens the
          // target's turn, a Stop/session-end closes it. Pending
          // questions/permissions and PTY truth are folded in by the projection
          // itself (LiveTargetStateService), so only the turn edge is fed here.
          const lifecycle = turnLifecycle(signal)
          if (lifecycle && signal.arcTargetSessionId) {
            yield* liveStates.noteTurn(signal.arcTargetSessionId, lifecycle === "open")
          }
          if (shouldBackfillArtifacts(signal) && signal.cwd) {
            // Only the session that just stopped changed — persist just it (the
            // workspace is still parsed once). Falls back to the whole provider
            // sweep when the native session id is unknown.
            yield* artifactIngest.ingestWorkspace(
              signal.cwd,
              providerFilter(signal),
              signal.native.sessionId ?? undefined,
            )
            if (signal.arcTargetSessionId) yield* FiberMap.remove(pollers, signal.arcTargetSessionId)
          } else if (shouldPollArtifacts(signal) && signal.arcTargetSessionId) {
            yield* FiberMap.run(pollers, signal.arcTargetSessionId, pollArtifacts(signal), {
              onlyIfMissing: true,
              startImmediately: true,
            })
          }
        }),
      ),
      Effect.forkScoped,
    )

    // --- Reactive control-plane state ---
    // The control plane is no longer broadcast over custom IPC: every renderer
    // live read is now an Effect RPC server stream (sessions/chats/workspaces/
    // live target states as full-list `Watch*` streams; chat messages/activity,
    // pending requests, and work as `Watch*Changes` invalidation-signal streams —
    // see shared/rpc.ts). The controller keeps only the raw PTY/hook data plane
    // above and the session-driven orchestration below.

    yield* Stream.runForEach(sessions.changes, (list) =>
      Effect.gen(function* () {
        const activePaths = new Map<string, string>()
        for (const session of list) {
          const path = transcriptPathToWatch(session)
          if (path) activePaths.set(session.id, path)
        }

        // Stop watchers for targets that went inactive or whose transcript path
        // changed; a changed path is dropped here and re-added below against the
        // new file.
        for (const [targetSessionId, watchedPath] of watchedTargets) {
          if (activePaths.get(targetSessionId) === watchedPath) continue
          watchedTargets.delete(targetSessionId)
          yield* FiberMap.remove(transcriptWatchers, targetSessionId)
        }

        for (const session of list) {
          const path = activePaths.get(session.id)
          if (!path || watchedTargets.has(session.id)) continue
          watchedTargets.set(session.id, path)
          yield* FiberMap.run(transcriptWatchers, session.id, runTranscriptWatcher(session), {
            onlyIfMissing: true,
            startImmediately: true,
          })
        }
      }),
    ).pipe(Effect.forkScoped)
    // A target whose PTY is not attached cannot be awaiting an answer under arc:
    // on boot every restored session is detached, and a live session detaches on
    // exit. Either way its still-pending requests are stale, so supersede them so
    // the sidebar stops flagging dead sessions. `sessions.changes` replays the
    // current list on subscribe (covering boot) then every transition (covering
    // exit); supersede is idempotent and only re-broadcasts when it clears rows.
    yield* Stream.runForEach(sessions.changes, (list) =>
      Effect.forEach(
        list.filter((session) => !session.attached),
        (session) =>
          // A detached/exited child holds no open turn — drop its marker so a
          // relaunch under the same target id does not inherit a stale
          // "generating", then retire its now-stale pending requests.
          chatMessages
            .supersedePendingForTarget(session.id)
            .pipe(Effect.andThen(liveStates.clearTurn(session.id))),
        { discard: true },
      ),
    ).pipe(Effect.forkScoped)

    // The controller is acquired purely for the long-lived orchestration forked
    // above; a fresh window needs no snapshot replay because every live read
    // streams its current value on subscribe (or pulls it via its query).
  })
