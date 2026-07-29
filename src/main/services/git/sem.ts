import { Effect, Schema } from "effect"
import type { DiffEntityStats } from "../../../shared/git.js"
import { runSem } from "./exec.js"

/**
 * Entity-level change facts from the optional `sem` binary.
 *
 * `sem diff --format json` parses each side of the diff with tree-sitter and
 * reports which *entities* (functions, classes, tests, types) moved, instead of
 * which lines did. Two fields carry most of the value:
 *
 * - `entityType` distinguishes `test`/`test_suite` from real source entities, so
 *   test classification costs nothing and doesn't depend on path conventions.
 * - `structuralChange` says whether the parse tree actually changed. A file whose
 *   entities all came back `false` was reformatted, not rewritten.
 *
 * `sem` is not a hard dependency. Every entry point here returns null rather than
 * failing when the binary is absent, and the diff tree falls back to line counts.
 */

/** One changed entity. `sem` also inlines `beforeContent`/`afterContent` — the
 * full text of both sides of every entity, which is ~85% of the payload (1.3MB
 * of 1.5MB on a 5-commit range here). They are deliberately absent from this
 * struct: excess fields are ignored on decode, so the content never survives
 * past `JSON.parse` and never crosses the Rpc seam. Diff text is fetched
 * per-file, on demand, by `GetWorkspaceGitFileDiff`. */
const SemChange = Schema.Struct({
  entityId: Schema.String,
  changeType: Schema.String,
  entityType: Schema.String,
  entityName: Schema.NullOr(Schema.String),
  filePath: Schema.String,
  oldFilePath: Schema.optional(Schema.NullOr(Schema.String)),
  /** Null for added/deleted entities — there is no other side to compare. */
  structuralChange: Schema.optional(Schema.NullOr(Schema.Boolean)),
})

const SemDiff = Schema.Struct({
  changes: Schema.Array(SemChange),
})

const decodeSemDiff = Schema.decodeUnknownEffect(SemDiff)

/** Entity types `sem` reports that aren't a named piece of code: `orphan` is
 * module-level text (imports, top-level statements) and `chunk` is the fallback
 * for languages with no parser. Both count toward movement but neither is worth
 * naming in a file row's subtitle. */
const UNNAMED_ENTITY_TYPES: ReadonlySet<string> = new Set(["orphan", "chunk", "section"])

const TEST_ENTITY_TYPES: ReadonlySet<string> = new Set(["test", "test_suite", "test_hook"])

/** What `sem` observed for one file. */
export interface SemFileFacts {
  readonly stats: DiffEntityStats
  /** True when `sem` classified any entity in the file as a test. */
  readonly hasTests: boolean
  /** Named entities that moved, most structural first, capped for display. */
  readonly topEntities: ReadonlyArray<string>
}

export interface SemFacts {
  readonly byPath: ReadonlyMap<string, SemFileFacts>
}

const MAX_NAMED_ENTITIES = 4

/**
 * Run `sem diff` over `args` (a git range, or nothing for the working tree) and
 * fold the entity changes down to per-file facts.
 *
 * Returns null — never fails — when `sem` is not installed or exits non-zero, so
 * a missing optional binary degrades the tree rather than breaking the pane.
 */
export const semFactsFor = (
  cwd: string,
  args: ReadonlyArray<string>,
): Effect.Effect<SemFacts | null> =>
  Effect.gen(function* () {
    const result = yield* Effect.promise(() => runSem(cwd, ["diff", "--format", "json", ...args]))
    if (result.errored) {
      yield* Effect.logDebug("sem binary not installed — diff tree falls back to line counts")
      return null
    }
    if (result.exitCode !== 0 || result.stdout.trim() === "") {
      yield* Effect.logWarning(`sem diff exited ${result.exitCode} — diff tree falls back to line counts`)
      return null
    }

    const parsed = yield* Effect.try({
      try: () => JSON.parse(result.stdout) as unknown,
      catch: (cause) => cause,
    }).pipe(Effect.orElseSucceed(() => null))
    if (parsed === null) {
      yield* Effect.logWarning("sem diff emitted unparseable JSON — diff tree falls back to line counts")
      return null
    }

    const decoded = yield* decodeSemDiff(parsed).pipe(
      Effect.tapError((e) => Effect.logWarning(`sem diff payload did not decode: ${e}`)),
      Effect.orElseSucceed(() => null),
    )
    if (decoded === null) return null

    return foldSemChanges(decoded.changes)
  }).pipe(Effect.withSpan("arc.git.sem_diff"))

interface MutableFileFacts {
  added: number
  modified: number
  removed: number
  moved: number
  structural: number
  cosmetic: number
  hasTests: boolean
  named: Array<{ readonly name: string; readonly structural: boolean }>
}

const emptyFile = (): MutableFileFacts => ({
  added: 0,
  modified: 0,
  removed: 0,
  moved: 0,
  structural: 0,
  cosmetic: 0,
  hasTests: false,
  named: [],
})

/** Fold a flat entity-change list into per-file counters. Exported for tests. */
export const foldSemChanges = (changes: ReadonlyArray<typeof SemChange.Type>): SemFacts => {
  const byPath = new Map<string, MutableFileFacts>()

  for (const change of changes) {
    // A rename reports the new path in `filePath`; keying on it lines the facts
    // up with git's status, which also names the destination.
    const file = byPath.get(change.filePath) ?? emptyFile()
    byPath.set(change.filePath, file)

    switch (change.changeType) {
      case "added":
        file.added += 1
        break
      case "deleted":
        file.removed += 1
        break
      case "moved":
      case "renamed":
      case "reordered":
        file.moved += 1
        break
      default:
        file.modified += 1
        break
    }

    // `structuralChange` is only meaningful for a modified entity: added and
    // deleted entities have no counterpart to compare against, and counting
    // their null as "cosmetic" would call a brand-new function a formatting fix.
    if (change.structuralChange === true) file.structural += 1
    else if (change.structuralChange === false) file.cosmetic += 1

    if (TEST_ENTITY_TYPES.has(change.entityType)) file.hasTests = true

    if (change.entityName && !UNNAMED_ENTITY_TYPES.has(change.entityType)) {
      file.named.push({ name: change.entityName, structural: change.structuralChange !== false })
    }
  }

  const folded = new Map<string, SemFileFacts>()
  for (const [path, file] of byPath) {
    // Structural entities first so the subtitle names what actually changed, not
    // whichever function happened to be reformatted first in the file.
    const seen = new Set<string>()
    const topEntities: Array<string> = []
    for (const entity of [...file.named].sort((a, b) => Number(b.structural) - Number(a.structural))) {
      if (seen.has(entity.name)) continue
      seen.add(entity.name)
      topEntities.push(entity.name)
      if (topEntities.length === MAX_NAMED_ENTITIES) break
    }

    folded.set(path, {
      stats: {
        added: file.added,
        modified: file.modified,
        removed: file.removed,
        moved: file.moved,
        structural: file.structural,
        cosmetic: file.cosmetic,
      },
      hasTests: file.hasTests,
      topEntities,
    })
  }

  return { byPath: folded }
}
