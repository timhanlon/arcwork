import { Effect } from "effect"

/**
 * Explicit service failure policy.
 *
 * arc has two kinds of persistence, and they must not share one error path:
 *
 * - **Best-effort observation** — hook/artifact ingestion and projection. These
 *   are lossy by nature (a CLI may die mid-write, an artifact may be malformed).
 *   A failure here degrades to a logged warning and a fallback value; it must
 *   never fail the caller or surface to the user.
 * - **Required, user-visible state** — anything the user just asked for and is
 *   waiting on (composer submission, launching/resuming a target). These must
 *   fail loudly: the operation reports failure rather than silently swallowing
 *   it. Do NOT wrap those in {@link bestEffort}; let the error propagate so the
 *   RPC seam can return a typed failure the renderer renders.
 *
 * This combinator names the first policy so the distinction is explicit at every
 * call site, instead of an undifferentiated `logWarning` + `orElseSucceed`
 * scattered through service code.
 */
export const bestEffort =
  <A>(context: string, fallback: A) =>
  <E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, never, R> =>
    effect.pipe(
      Effect.tapError((e) => Effect.logWarning(`${context}: ${String(e)}`)),
      Effect.orElseSucceed(() => fallback),
    )
