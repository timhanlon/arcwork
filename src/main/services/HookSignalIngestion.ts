import { Effect } from "effect"
import type { HookSignal } from "../hooks/signals.js"

export interface HookSignalIngestionDeps {
  readonly raw: {
    readonly ingestSignal: (signal: HookSignal) => Effect.Effect<boolean, never>
  }
  readonly activity: {
    readonly ingestSignal: (signal: HookSignal) => Effect.Effect<number, never>
  }
  readonly chat: {
    readonly ingestSignal: (signal: HookSignal) => Effect.Effect<number, never>
  }
}

export interface HookSignalIngestionResult {
  readonly rawInserted: boolean
  readonly activityInserted: number
  readonly chatInserted: number
}

/** Persist raw hook signal, then activity projection, then chat projection. */
export const ingestHookSignal = (
  deps: HookSignalIngestionDeps,
  signal: HookSignal,
): Effect.Effect<HookSignalIngestionResult, never> =>
  deps.raw.ingestSignal(signal).pipe(
    Effect.flatMap((rawInserted) =>
      deps.activity.ingestSignal(signal).pipe(
        Effect.flatMap((activityInserted) =>
          deps.chat.ingestSignal(signal).pipe(
            Effect.map((chatInserted) => ({
              rawInserted,
              activityInserted,
              chatInserted,
            })),
          ),
        ),
      ),
    ),
  )
