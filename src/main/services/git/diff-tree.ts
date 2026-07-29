import type { WorkspaceId } from "../../../shared/ids.js"
import type {
  DiffFileKind,
  DiffTree,
  DiffTreeFile,
  DiffTreeGroup,
  GitFileChange,
} from "../../../shared/git.js"
import type { SemFacts } from "./sem.js"

/**
 * Build the diff tree: turn a flat change-set into ordered module groups.
 *
 * The whole point is that `+414 −60` is a bad proxy for how much attention a
 * change needs. Three rules carry that:
 *
 *  1. **Quarantine generated files.** A lockfile bump is 9k lines and zero
 *     thought. It collapses into one row at the bottom and is excluded from the
 *     authored-file count, so it can never inflate the apparent size.
 *  2. **Group by module, not by alphabet.** Files you read together sit together,
 *     and a test directory follows the module it covers rather than sorting to
 *     wherever `__tests__` lands alphabetically.
 *  3. **Rank by what moved.** With `sem` present the ordering key is the count of
 *     *structural* entity changes, so a file that was only reformatted sinks
 *     below one that gained a function, regardless of line counts.
 *
 * Pure and dependency-free — everything I/O-shaped is resolved by the caller.
 */

// ── Classification ───────────────────────────────────────────────────────────

const LOCKFILES: ReadonlySet<string> = new Set([
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "Cargo.lock",
  "poetry.lock",
  "uv.lock",
  "Gemfile.lock",
  "composer.lock",
  "go.sum",
  "flake.lock",
  "Package.resolved",
])

/** Directory names whose entire subtree is tool output. */
const GENERATED_DIRS: ReadonlySet<string> = new Set([
  "node_modules",
  "dist",
  "build",
  "out",
  "vendor",
  "coverage",
  "__snapshots__",
  "__generated__",
  ".next",
  ".turbo",
  ".svelte-kit",
  "target",
])

const GENERATED_SUFFIXES: ReadonlyArray<string> = [
  ".min.js",
  ".min.css",
  ".map",
  ".snap",
  ".pb.go",
  "_pb2.py",
  ".g.dart",
  ".freezed.dart",
]

/** Infix markers that mean "a tool wrote this", wherever they appear in a name. */
const GENERATED_INFIXES: ReadonlyArray<string> = [".generated.", ".gen.", "_generated.", ".designer."]

const TEST_DIRS: ReadonlySet<string> = new Set(["__tests__", "test", "tests", "spec", "e2e"])

const TEST_INFIXES: ReadonlyArray<string> = [".test.", ".spec.", "_test.", "_spec."]

const SCHEMA_DIRS: ReadonlySet<string> = new Set(["migrations", "migration", "schema"])

const SCHEMA_SUFFIXES: ReadonlyArray<string> = [".sql", ".proto", ".prisma", ".graphql", ".gql"]

const CONFIG_SUFFIXES: ReadonlyArray<string> = [
  ".json",
  ".yaml",
  ".yml",
  ".toml",
  ".ini",
  ".cfg",
  ".conf",
  ".env",
  ".properties",
]

const DOC_SUFFIXES: ReadonlyArray<string> = [".md", ".mdx", ".rst", ".txt", ".adoc"]

const segmentsOf = (filePath: string): ReadonlyArray<string> => filePath.split("/")

const basenameOf = (filePath: string): string => segmentsOf(filePath).at(-1) ?? filePath

/** The directory a file lives in, with a trailing slash; `""` at the repo root. */
export const dirnameOf = (filePath: string): string => {
  const cut = filePath.lastIndexOf("/")
  return cut === -1 ? "" : filePath.slice(0, cut + 1)
}

const endsWithAny = (name: string, suffixes: ReadonlyArray<string>): boolean =>
  suffixes.some((suffix) => name.endsWith(suffix))

const isGenerated = (filePath: string): boolean => {
  const name = basenameOf(filePath)
  if (LOCKFILES.has(name)) return true
  if (segmentsOf(dirnameOf(filePath)).some((segment) => GENERATED_DIRS.has(segment))) return true
  if (endsWithAny(name, GENERATED_SUFFIXES)) return true
  return GENERATED_INFIXES.some((infix) => name.includes(infix))
}

const isTestPath = (filePath: string): boolean => {
  const name = basenameOf(filePath)
  if (TEST_INFIXES.some((infix) => name.includes(infix))) return true
  return segmentsOf(dirnameOf(filePath)).some((segment) => TEST_DIRS.has(segment))
}

/**
 * Classify a file for grouping, ordering, and its row icon.
 *
 * Order matters: generated wins over everything (a generated test fixture is
 * still noise), and `hasSemTests` — tree-sitter having actually found test
 * entities inside the file — beats the path convention, so a test helper that
 * lives outside `__tests__` still classifies correctly.
 */
export const classifyFile = (filePath: string, hasSemTests: boolean): DiffFileKind => {
  if (isGenerated(filePath)) return "generated"
  if (hasSemTests || isTestPath(filePath)) return "test"

  const name = basenameOf(filePath)
  if (endsWithAny(name, SCHEMA_SUFFIXES)) return "schema"
  if (segmentsOf(dirnameOf(filePath)).some((segment) => SCHEMA_DIRS.has(segment))) return "schema"
  if (endsWithAny(name, DOC_SUFFIXES)) return "docs"
  // A leading-dot file with no other extension (`.gitignore`) is config too.
  if (endsWithAny(name, CONFIG_SUFFIXES) || (name.startsWith(".") && !name.slice(1).includes("."))) {
    return "config"
  }
  return "source"
}

// ── Grouping ─────────────────────────────────────────────────────────────────

const GENERATED_GROUP_ID = "generated"

interface DraftGroup {
  readonly id: string
  readonly label: string
  readonly kind: DiffFileKind
  readonly files: Array<DiffTreeFile>
}

/** Rank a file within its group: what actually moved first, size as the tiebreak. */
const fileWeight = (file: DiffTreeFile): number => {
  const entities = file.entities
  const structural = entities ? entities.structural + entities.added + entities.removed : 0
  return structural * 1000 + file.added + file.deleted
}

const churnOf = (files: ReadonlyArray<DiffTreeFile>): { added: number; deleted: number } =>
  files.reduce(
    (acc, file) => ({ added: acc.added + file.added, deleted: acc.deleted + file.deleted }),
    { added: 0, deleted: 0 },
  )

/**
 * True when every entity `sem` found in this file was a non-structural edit —
 * reformatting, a comment, a moved brace.
 *
 * Added and removed entities disqualify a file outright: `sem` reports
 * `structuralChange: null` for them (there is no counterpart to compare), so
 * testing `structural === 0` alone would call a file that gained two functions
 * "formatting only".
 */
const isCosmeticOnly = (file: DiffTreeFile): boolean => {
  const e = file.entities
  if (e === null) return false
  return e.cosmetic > 0 && e.structural === 0 && e.added === 0 && e.removed === 0 && e.moved === 0
}

const entitiesChangedOf = (files: ReadonlyArray<DiffTreeFile>): number =>
  files.reduce((total, file) => {
    const e = file.entities
    return total + (e ? e.added + e.modified + e.removed + e.moved : 0)
  }, 0)

/** A group's rank: total structural movement, falling back to churn when `sem`
 * is unavailable and every file's entity stats are null. */
const groupWeight = (files: ReadonlyArray<DiffTreeFile>): number =>
  files.reduce((total, file) => total + fileWeight(file), 0)

// ── Captions ─────────────────────────────────────────────────────────────────

/** Rule-derived, never invented — each caption restates a fact already computed
 * above, so the tree never claims to understand intent it cannot see. */
const captionFor = (group: DraftGroup, entitiesChanged: number, allCosmetic: boolean): string | null => {
  if (group.kind === "generated") {
    const names = group.files.map((file) => basenameOf(file.path))
    const lead = names.slice(0, 2).join(", ")
    return `${lead}${names.length > 2 ? ` and ${names.length - 2} more` : ""} — collapsed by default`
  }
  if (allCosmetic) return "Formatting only — safe to skim"
  if (group.kind === "test") {
    return entitiesChanged > 0 ? `${entitiesChanged} test entities touched` : "Test coverage"
  }
  if (group.kind === "schema") return "Schema change — review for compatibility"
  if (group.kind === "docs") return "Documentation"
  return null
}

// ── Build ────────────────────────────────────────────────────────────────────

export interface BuildDiffTreeInput {
  readonly workspaceId: WorkspaceId
  readonly changes: ReadonlyArray<GitFileChange>
  /** Null when `sem` is absent or failed — the tree degrades to line counts. */
  readonly sem: SemFacts | null
}

export const buildDiffTree = ({
  workspaceId,
  changes,
  sem,
}: BuildDiffTreeInput): DiffTree => {
  // 1. Classify every change into a tree leaf.
  const drafts = new Map<string, DraftGroup>()
  for (const change of changes) {
    const facts = sem?.byPath.get(change.path)
    const kind = classifyFile(change.path, facts?.hasTests ?? false)
    const file: DiffTreeFile = {
      path: change.path,
      // Filled in once the group's label is known — a group of one standalone
      // file labels itself with the full path, so the row must not repeat it.
      displayPath: change.path,
      originalPath: change.originalPath ?? null,
      status: change.status,
      kind,
      added: change.added,
      deleted: change.deleted,
      isBinary: change.isBinary,
      entities: facts?.stats ?? null,
      topEntities: facts?.topEntities ?? [],
    }

    // Generated files collapse into a single bucket wherever they live: their
    // directory is never something you navigate by.
    const groupId = kind === "generated" ? GENERATED_GROUP_ID : `${dirnameOf(change.path)} ${kind}`
    const label = kind === "generated" ? "" : dirnameOf(change.path)
    const draft = drafts.get(groupId) ?? { id: groupId, label, kind, files: [] }
    draft.files.push(file)
    drafts.set(groupId, draft)
  }

  // 2. Order files within each group, and order the groups themselves.
  const ordered = [...drafts.values()].sort((a, b) => groupWeight(b.files) - groupWeight(a.files))
  const generated = ordered.filter((group) => group.kind === "generated")
  const authored = ordered.filter((group) => group.kind !== "generated")

  const arranged = attachTestGroups(authored)

  // 3. Project to the wire shape.
  const groups: Array<DiffTreeGroup> = [...arranged, ...generated].map((group) => {
    const files = [...group.files].sort((a, b) => fileWeight(b) - fileWeight(a))
    const { added, deleted } = churnOf(files)
    const entitiesChanged = entitiesChangedOf(files)
    // A lone migration or config file earns its own row — its directory is not
    // a module you'd read as a unit. Source and test groups always stay folder-
    // labelled, so a single test file still reads as "the tests for this module".
    const standalone =
      files.length === 1 && (group.kind === "schema" || group.kind === "config" || group.kind === "docs")
    const label = group.kind === "generated"
      ? `${files.length} generated file${files.length === 1 ? "" : "s"}`
      : standalone
        ? (files[0]?.path ?? group.label)
        : group.label || "(repo root)"

    const allCosmetic = files.length > 0 && files.every(isCosmeticOnly)

    return {
      id: group.id,
      label,
      caption: captionFor(group, entitiesChanged, allCosmetic),
      kind: group.kind,
      added,
      deleted,
      entitiesChanged,
      defaultCollapsed: group.kind === "generated",
      files: files.map((file) => ({
        ...file,
        displayPath: standalone ? basenameOf(file.path) : file.path.slice(group.label.length),
      })),
    }
  })

  const allFiles = groups.flatMap((group) => group.files)
  const { added, deleted } = churnOf(allFiles)

  return {
    workspaceId,
    added,
    deleted,
    stats: {
      modules: groups.filter((group) => group.kind === "source").length,
      authoredFiles: allFiles.filter((file) => file.kind !== "generated").length,
      generatedFiles: allFiles.filter((file) => file.kind === "generated").length,
      entitiesChanged: entitiesChangedOf(allFiles),
      cosmeticOnlyFiles: allFiles.filter(isCosmeticOnly).length,
    },
    groups,
    semAvailable: sem !== null,
  }
}

/**
 * Move each test group to sit directly beneath the module it covers, instead of
 * leaving it wherever its own weight ranked it.
 *
 * "Covers" is the longest path-prefix match against a non-test group —
 * `src/billing/__tests__/` attaches to `src/billing/`. A test group with no
 * such match keeps its weight-ranked position.
 */
const attachTestGroups = (groups: ReadonlyArray<DraftGroup>): ReadonlyArray<DraftGroup> => {
  const tests = groups.filter((group) => group.kind === "test")
  const rest = groups.filter((group) => group.kind !== "test")
  if (tests.length === 0 || rest.length === 0) return groups

  const attached = new Map<string, Array<DraftGroup>>()
  const orphans: Array<DraftGroup> = []
  for (const test of tests) {
    let best: DraftGroup | undefined
    for (const candidate of rest) {
      if (!candidate.label || !test.label.startsWith(candidate.label)) continue
      if (!best || candidate.label.length > best.label.length) best = candidate
    }
    if (!best) {
      orphans.push(test)
      continue
    }
    const bucket = attached.get(best.id) ?? []
    bucket.push(test)
    attached.set(best.id, bucket)
  }

  return [...rest.flatMap((group) => [group, ...(attached.get(group.id) ?? [])]), ...orphans]
}
