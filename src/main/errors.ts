import { Data } from "effect"

/**
 * Expected request/data errors (unknown workspace, chat, provider, etc.). A
 * `Data.TaggedError` so it matches the rest of the codebase's error style
 * (`work/store.ts`, `ingest/errors.ts`): structural equality, clean `Cause`
 * rendering, and `Effect.catchTag("ArcRequestError", …)` support. Still a real
 * `Error` subclass, so the `instanceof` check at the RPC seam keeps working.
 */
export class ArcRequestError extends Data.TaggedError("ArcRequestError")<{
  readonly message: string
}> {}

export const arcRequestError = (message: string): ArcRequestError => new ArcRequestError({ message })
