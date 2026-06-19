import { Context, Effect, Layer } from "effect"
import { rawHookSignalRowFrom } from "../hooks/raw-hook-signal.js"
import type { HookSignal } from "../hooks/signals.js"
import { ArcStore } from "../db/store.js"
import { nowIso } from "../clock.js"
import { bestEffort } from "./failure-policy.js"

/**
 * Persists every parsed hook signal before activity/chat projection so hooks
 * that map to zero downstream drafts still leave a queryable trace.
 */
export class RawHookSignalService extends Context.Service<
  RawHookSignalService,
  {
    readonly ingestSignal: (signal: HookSignal) => Effect.Effect<boolean, never>
  }
>()("RawHookSignalService") {}

export const RawHookSignalServiceLive = Layer.effect(
  RawHookSignalService,
  Effect.gen(function* () {
    const db = yield* ArcStore

    // Best-effort observation: a queryable trace of every parsed signal, but a
    // persistence failure never blocks downstream activity/chat projection.
    const ingestSignal = (signal: HookSignal) =>
      Effect.flatMap(nowIso, (now) =>
        db
          .insertRawHookSignal(rawHookSignalRowFrom(signal, now))
          .pipe(bestEffort("raw hook signal persist failed", false)),
      )

    return { ingestSignal }
  }),
)
