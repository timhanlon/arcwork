import { Context, Effect, Layer, Queue, Stream, SubscriptionRef } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { nowIso } from "../clock.js"
import { EventEmitter } from "node:events"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import * as pty from "node-pty"
import type { IPty } from "node-pty"
import type { TargetSession } from "../../shared/instance.js"
import { arcEnvTags, arcMcpBearerToken } from "../../shared/env-tags.js"
import { installProviderHooks } from "../hooks/install.js"
import { cursorPluginLaunchArgs, installCursorPlugin } from "../hooks/cursor-plugin.js"
import { isMcpProvider, providerMcpLaunchArgs } from "../mcp/client-config.js"
import { ARC_HOOK_HELPER_ENV, ARC_HOOK_SOCK_ENV, arcOwnedHelperFile } from "../hooks/signals.js"
import { HookSignalServer } from "./HookSignalServer.js"
import { ProviderRegistry } from "./ProviderRegistry.js"
import { WorkspaceService } from "./WorkspaceService.js"
import { ChatService } from "./ChatService.js"
import { ArcStore } from "../db/store.js"
import { withSqlOperation } from "../db/sql-operation.js"
import { resolveArcDb, resolveProfile } from "../db/paths.js"
import type { TargetSessionRow } from "../db/schema.js"
import { type ArcRequestError, arcRequestError } from "../errors.js"
import { type ChatId, newArcId } from "../../shared/ids.js"
import { PTY_SUBMIT_SEQUENCE, writePromptWithDelayedSubmit } from "../pty-submit.js"
import { tracePtyChunk } from "./pty-trace.js"

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

/**
 * Once the session is ready (its prompt glyph showed, or first output as a
 * fallback), how long to wait before sending Enter on a prefilled draft. The
 * composer needs a beat to render the seeded text before it'll accept submit.
 */
const PREFILL_SUBMIT_SETTLE_MS = 400

/**
 * If a provider's prompt glyph never appears (a glyph mismatch, a CLI that
 * draws its prompt differently, or no glyph configured), deliver the seeded
 * prompt anyway after this long — better a slightly-early submit than a session
 * that strands its prompt forever.
 */
const READY_FALLBACK_MS = 10_000

/** Cap on the rolling PTY tail we scan for the readiness glyph. */
const READY_TAIL_CHARS = 4000

/** True once the provider's ready glyph appears in the last few lines of output.
 * The glyph is a printable char that never occurs inside an escape sequence, so a
 * plain substring test needs no ANSI stripping; newline split scopes it to the tail. */
const tailShowsGlyph = (tail: string, glyph: string): boolean =>
  tail
    .split(/\r?\n/)
    .slice(-5)
    .some((line) => line.includes(glyph))
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

    // Restore persisted sessions on boot. Their PTYs died with the last process,
    // so any previously-live state is now unconfirmed → "unknown" (an already
    // "exited" row stays exited). The persisted row still carries cwd +
    // nativeSessionId, which a manual relaunch (and the future auto-resume arc)
    // can use. A load failure starts empty (logged).
    const persisted = yield* db.loadTargetSessions.pipe(
      Effect.tapError((e) => Effect.logWarning(`session load failed; starting empty: ${e}`)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<TargetSessionRow>),
    )
    const initialMap = new Map<string, TargetSession>()
    const restoredHookTargets: Array<{ readonly cwd: string; readonly provider: string }> = []
    for (const r of persisted) {
      initialMap.set(r.id, {
        _tag: "TargetSession",
        id: r.id,
        provider: r.provider,
        origin: r.origin === "orchestrated" ? "orchestrated" : "manual",
        preset: r.preset ?? undefined,
        chatId: r.chatId,
        cwd: r.cwd,
        nativeSessionId: r.nativeSessionId ?? undefined,
        nativeTranscriptPath: r.nativeTranscriptPath ?? undefined,
        attached: false,
        state: r.state === "exited" ? "exited" : "unknown",
        startedAt: r.startedAt,
      })
      if (r.state !== "exited") {
        restoredHookTargets.push({ cwd: r.cwd, provider: r.provider })
      }
    }

    // A still-running CLI from a previous Arc Work process inherited the
    // same deterministic socket path, but the server died with the old app.
    // Re-arm sockets during startup so delayed hooks (notably Codex
    // SessionStart, which can wait until the first submitted prompt) can still
    // bind restored target sessions.
    const armedRestoredHooks = new Set<string>()
    for (const target of restoredHookTargets) {
      const key = `${target.cwd}\u0000${target.provider}`
      if (armedRestoredHooks.has(key)) continue
      armedRestoredHooks.add(key)
      yield* hookServer.ensureListening(target.cwd)
      const result = yield* installProviderHooks(target.cwd, target.provider)
      if (!result.installed) {
        yield* Effect.logWarning(
          `restored hook install failed for ${target.provider} in ${target.cwd}; hook signals unavailable: ${result.reason}`,
        )
      }
    }

    // SubscriptionRef (not Ref) so the session list is observable: `changes`
    // pushes the current value, then every update. This is the Effect-idiomatic
    // reactive store; the renderer mirrors it through an atom. ArcStore is its
    // durable mirror — writes below are awaited (fast synchronous SQLite, and
    // ordered: upsert lands before any bind/state update) but a write *failure*
    // never *fails* the live op.
    const store = yield* SubscriptionRef.make(initialMap)
    const ptys = new Map<string, IPty>()
    const events = new EventEmitter()
    const arcDb = resolveArcDb()

    // PTY exit handling runs as structured Effect work, not inline in node-pty's
    // `onExit` callback. The callback only offers the exit notification here; a
    // single scoped fiber (below) drains the queue and applies the whole exit
    // policy — broadcast the renderer exit event, drop the PTY handle, mark the
    // session exited, persist best-effort. This matches the controller's
    // EventEmitter-to-Stream seam and gives exit handling one supervised lifetime
    // and one error policy, instead of a bare `runSync`/`runFork` pair firing
    // from outside the runtime on every child death.
    interface PtyExit {
      readonly sessionId: string
      readonly exitCode: number
    }
    const exits = yield* Queue.make<PtyExit>()

    // First-output observability. The splash banner is the child's very first
    // PTY write; on launch it can race ahead of the `LaunchTarget` RPC that binds
    // the session id in the renderer, so the renderer drops it (Terminal.tsx
    // gates on a known id). To see that race in Lensflare we record, per launch,
    // how long after spawn the first byte arrived and how big that first burst
    // was. Compared against the `arc.target.launch` span (the id round-trip),
    // a first_output latency well below the launch span means the splash lost.
    // Offered from the raw `onData` callback, logged by a scoped Effect fiber.
    interface FirstOutput {
      readonly sessionId: string
      readonly provider: string
      readonly firstByteMs: number
      readonly firstChunkBytes: number
    }
    const firstOutputs = yield* Queue.make<FirstOutput>()
    yield* Stream.fromQueue(firstOutputs).pipe(
      Stream.runForEach((f) =>
        Effect.logInfo(
          `target first-output target=${f.sessionId} provider=${f.provider} ` +
            `firstByteMs=${f.firstByteMs} firstChunkBytes=${f.firstChunkBytes}`,
        ).pipe(
          Effect.annotateLogs({
            "arc.event": "target.first_output",
            "arc.provider": f.provider,
            "arc.target_session_id": f.sessionId,
            "arc.first_byte_ms": f.firstByteMs,
            "arc.first_chunk_bytes": f.firstChunkBytes,
          }),
        ),
      ),
      Effect.forkScoped,
    )
    const handleExit = ({ sessionId, exitCode }: PtyExit) =>
      Effect.logInfo(`target exited target=${sessionId} code=${exitCode}`).pipe(
        Effect.andThen(
          Effect.sync(() => {
            events.emit("exit", { sessionId, exitCode })
            ptys.delete(sessionId)
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

    const claudeProjectSlug = (cwd: string): string => cwd.replaceAll("/", "-").replaceAll(".", "-")
    const inferredTranscriptPath = (s: TargetSession): string | undefined => {
      if (!s.nativeSessionId) return undefined
      if (s.nativeTranscriptPath) return s.nativeTranscriptPath
      if (s.provider === "claude") {
        return path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(s.cwd), `${s.nativeSessionId}.jsonl`)
      }
      return undefined
    }
    const canResume = (s: TargetSession): boolean => {
      if (!s.nativeSessionId) return false
      const transcriptPath = inferredTranscriptPath(s)
      if (s.provider === "claude") return Boolean(transcriptPath && fs.existsSync(transcriptPath))
      return true
    }
    const asList = (m: ReadonlyMap<string, TargetSession>): ReadonlyArray<TargetSession> =>
      Array.from(m.values()).map((s) => ({
        ...s,
        attached: ptys.has(s.id),
        resumable: canResume(s),
      }))
    const list = SubscriptionRef.get(store).pipe(Effect.map(asList))
    const changes = Stream.map(SubscriptionRef.changes(store), asList)

    // Provider integration argv, shared by launch + resume. cursor writes its
    // Arc-owned plugin dir and loads it via `--plugin-dir`; claude/codex declare
    // the arc MCP server inline. Best-effort: a failed cursor plugin write logs
    // and falls through to no extra args rather than blocking the spawn.
    const buildProviderArgs = (
      provider: string,
      scope: { chatId: string; targetSessionId: string },
    ): Effect.Effect<Array<string>> =>
      Effect.gen(function* () {
        // Resolve the profile once here (the main process has ARC_PROFILE pinned at
        // boot) and thread it into the MCP config so a dev-launched session targets
        // :7794 and a stable one :7793 — its writes land in the launching app's DB.
        const profile = resolveProfile()
        if (provider === "cursor") {
          // Per-session plugin dir carrying a literal bearer: Cursor won't expand
          // ${env:…} in MCP headers, so the token is baked in by session id here.
          const plugin = installCursorPlugin({
            scopeId: scope.targetSessionId,
            bearerToken: arcMcpBearerToken(scope),
          })
          if (!plugin.installed) {
            yield* Effect.logWarning(`cursor plugin install failed: ${plugin.reason ?? "unknown error"}`)
            return []
          }
          return [...cursorPluginLaunchArgs(plugin.dir, profile)]
        }
        return isMcpProvider(provider) ? [...providerMcpLaunchArgs(provider, profile)] : []
      })

    const resumeArgs = (provider: string, nativeSessionId: string | undefined): Array<string> | null => {
      if (!nativeSessionId) return null
      switch (provider) {
        case "claude":
          return ["--resume", nativeSessionId]
        case "codex":
          return ["resume", nativeSessionId]
        case "cursor":
          return ["--resume", nativeSessionId]
        default:
          return null
      }
    }

    const spawnAttached = (
      session: TargetSession,
      launchCmd: string,
      args: ReadonlyArray<string>,
      cols: number | undefined,
      rows: number | undefined,
      sockPath: string,
      writeAfterStart?: string,
      extraEnv: Readonly<Record<string, string>> = {},
      // When the prompt was *seeded* (prefill) rather than submitted, submit it
      // once the session is ready (its prompt glyph appears below).
      submitSeededAfterReady = false,
      // The CLI's input-prompt glyph; we hold the seeded prompt's paste/submit
      // until it shows in recent output, so the agent's first turn has its MCP
      // tools connected. Absent → first PTY output is the readiness signal.
      readyGlyph?: string,
    ) =>
      Effect.sync(() => {
        const spawnedAt = Date.now()
        const child = pty.spawn(launchCmd, [...args], {
          name: "xterm-color",
          cols: cols && cols > 0 ? Math.floor(cols) : 80,
          rows: rows && rows > 0 ? Math.floor(rows) : 24,
          cwd: session.cwd,
          env: {
            ...process.env,
            ...arcEnvTags({
              chatId: session.chatId,
              targetSessionId: session.id,
              provider: session.provider,
              dbPath: arcDb.dbPath,
            }),
            ...extraEnv,
            [ARC_HOOK_SOCK_ENV]: sockPath,
            // The Arc-owned helper to invoke (provider hooks + the git
            // post-commit hook both read this rather than a repo-local path).
            [ARC_HOOK_HELPER_ENV]: arcOwnedHelperFile(),
          } as Record<string, string>,
        })
        // Deliver the seeded prompt exactly once, when the session is ready:
        // paste-then-submit for stdin providers, a bare Enter for a prefilled
        // draft. Gated on the ready glyph so MCP has connected by turn 1.
        const hasSeededPrompt = Boolean(writeAfterStart) || submitSeededAfterReady
        let delivered = false
        const deliver = () => {
          if (delivered) return
          delivered = true
          clearTimeout(readyFallback)
          if (writeAfterStart) {
            writePromptWithDelayedSubmit((d) => child.write(d), writeAfterStart)
          } else if (submitSeededAfterReady) {
            setTimeout(() => {
              try {
                child.write(PTY_SUBMIT_SEQUENCE)
              } catch {
                /* child gone before submit — nothing to do */
              }
            }, PREFILL_SUBMIT_SETTLE_MS)
          }
        }
        // Fallback so a glyph mismatch or a quiet CLI never strands the prompt.
        const readyFallback = hasSeededPrompt ? setTimeout(deliver, READY_FALLBACK_MS) : undefined

        let firstChunkSeen = false
        let readyTail = ""
        child.onData((data) => {
          tracePtyChunk(session.id, data)
          if (!firstChunkSeen) {
            firstChunkSeen = true
            Queue.offerUnsafe(firstOutputs, {
              sessionId: session.id,
              provider: session.provider,
              firstByteMs: Date.now() - spawnedAt,
              firstChunkBytes: Buffer.byteLength(data, "utf8"),
            })
          }
          events.emit("data", { sessionId: session.id, data })
          if (!delivered && hasSeededPrompt) {
            readyTail = (readyTail + data).slice(-READY_TAIL_CHARS)
            // No glyph configured → first output is our readiness signal.
            if (!readyGlyph || tailShowsGlyph(readyTail, readyGlyph)) deliver()
          }
        })
        // Hand the exit off to the scoped consumer; no Effect runs from this
        // raw node-pty callback. `offerUnsafe` is a no-op once the queue is shut
        // down (scope close), so a child killed during app-quit disposal simply
        // isn't reprocessed — consistent with not persisting "exited" on a hard kill.
        child.onExit(({ exitCode }) => {
          clearTimeout(readyFallback)
          Queue.offerUnsafe(exits, { sessionId: session.id, exitCode })
        })
        ptys.set(session.id, child)
      })

    const launch = (req: LaunchRequest) =>
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

        const chatList = yield* chats.list
        const chat = chatList.find((c) => c.id === req.chatId)
        if (!chat) {
          return yield* Effect.fail(arcRequestError(`Unknown chat "${req.chatId}"`))
        }
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
        yield* spawnAttached(
          session,
          cap.launchCmd,
          args,
          req.cols,
          req.rows,
          sockPath,
          writeAfterStart,
          extraEnv,
          submitSeededAfterReady,
          cap.readyPromptGlyph,
        ).pipe(
          Effect.withSpan("arc.target.spawn", {
            attributes: { "arc.provider": req.provider, "arc.target_session_id": id },
          }),
        )
        yield* SubscriptionRef.update(store, (m) => new Map(m).set(session.id, session))
        yield* persistSession(session).pipe(
          Effect.withSpan("arc.target.persist", {
            attributes: { "arc.target_session_id": session.id },
          }),
        )
        yield* Effect.logInfo(
          `target launched provider=${session.provider} chat=${session.chatId} target=${session.id}`,
        )
        return session
      }).pipe(
        Effect.withSpan("arc.target.launch", {
          attributes: { "arc.provider": req.provider, "arc.chat_id": req.chatId },
        }),
      )

    const resume = (req: ResumeRequest) =>
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
          })),
          ...resumeBase,
        ]

        const session: TargetSession = { ...existing, attached: true, state: "running" }
        yield* spawnAttached(session, spec.interactive.launchCmd, args, req.cols, req.rows, sockPath)
        yield* SubscriptionRef.update(store, (m) => new Map(m).set(session.id, session))
        yield* persistSession(session)
        yield* Effect.logInfo(
          `target resumed provider=${session.provider} chat=${session.chatId} target=${session.id}`,
        )
        return session
      })

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
        try {
          child.kill("SIGTERM")
        } catch {
          /* raced the child's own exit between get and kill — already gone */
        }
        setTimeout(() => {
          // Force-kill only if THIS handle is still live after the grace
          // window. Identity-check, not just presence: a stop-then-resume of
          // the same session id within the window puts a *different* pty under
          // the same key, and that innocent new child must not be SIGKILLed.
          if (ptys.get(req.sessionId) !== child) return
          try {
            child.kill("SIGKILL")
          } catch {
            /* gone */
          }
        }, STOP_GRACE_MS)
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
        yield* SubscriptionRef.update(store, (m) =>
          new Map(m).set(session.id, {
            ...session,
            nativeSessionId,
            nativeTranscriptPath: nativeTranscriptPath ?? session.nativeTranscriptPath,
          }),
        )
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
        const child = ptys.get(req.instanceId)
        if (!child) return { accepted: false }
        writePromptWithDelayedSubmit((data) => child.write(data), req.text)
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
