import { Effect } from "effect"
import { arcIdOrNull } from "../../../shared/ids.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { TargetSessionRow } from "../../db/schema.js"
import { installProviderHooks } from "../../hooks/install.js"
import { ArcStore } from "../../db/store.js"
import { HookSignalServer } from "../HookSignalServer.js"

/**
 * Restore persisted target sessions on boot, returning the initial session map
 * the live SubscriptionRef is seeded from. Their PTYs died with the last
 * process, so any previously-live state is now unconfirmed → "unknown" (an
 * already "exited" row stays exited). The persisted row still carries cwd +
 * nativeSessionId, which a manual relaunch (and the future auto-resume arc) can
 * use. A load failure starts empty (logged).
 *
 * Also re-arms hook sockets for every restored non-exited target: a still-
 * running CLI from a previous Arc Work process inherited the same deterministic
 * socket path, but the server died with the old app. Re-arming during startup
 * lets delayed hooks (notably Codex SessionStart, which can wait until the first
 * submitted prompt) still bind restored sessions.
 */
export const restorePersistedSessions: Effect.Effect<
  Map<string, TargetSession>,
  never,
  ArcStore | HookSignalServer
> = Effect.gen(function* () {
  const db = yield* ArcStore
  const hookServer = yield* HookSignalServer

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
      spawnedBy: arcIdOrNull("target", r.spawnedBy) ?? undefined,
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

  return initialMap
})
