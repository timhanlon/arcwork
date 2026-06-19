import { Schema } from "effect"

/**
 * A provider artifact could not be read or parsed at the file level.
 * Per-line / per-blob corruption is NOT this error — that becomes a diagnostic
 * row so partial extraction still succeeds.
 */
export class ArtifactReadError extends Schema.TaggedErrorClass<ArtifactReadError>()(
  "ArtifactReadError",
  {
    provider: Schema.String,
    path: Schema.String,
    cause: Schema.Defect,
  },
) {
  get message(): string {
    return `arc-ingest: failed to read ${this.provider} artifact at ${this.path}`
  }
}

/** Reading a Cursor `store.db` (SQLite) failed even after the snapshot fallback. */
export class CursorReadError extends Schema.TaggedErrorClass<CursorReadError>()(
  "CursorReadError",
  {
    path: Schema.String,
    cause: Schema.Defect,
  },
) {
  get message(): string {
    return `arc-ingest: failed to read Cursor database at ${this.path}`
  }
}

/** Errors a provider may raise while listing or extracting native sessions. */
export type IngestError = ArtifactReadError | CursorReadError
