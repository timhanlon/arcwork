import { DateTime, Effect } from "effect"

/**
 * Current wall-clock instant as an ISO-8601 string (`2026-06-18T02:44:06.775Z`),
 * read through the Effect `Clock` rather than `new Date()`. Same format as
 * `new Date().toISOString()`, but deterministic under `TestClock` and consistent
 * with the rest of the time-dependent effects. Drop-in inside an `Effect.gen`:
 * `const now = yield* nowIso`.
 */
export const nowIso: Effect.Effect<string> = Effect.map(DateTime.now, DateTime.formatIso)
