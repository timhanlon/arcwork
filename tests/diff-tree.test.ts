import { describe, expect, it } from "vitest"
import type { GitFileChange } from "../src/shared/git.js"
import type { WorkspaceId } from "../src/shared/ids.js"
import { buildDiffTree, classifyFile } from "../src/main/services/git/diff-tree.js"
import { foldSemChanges } from "../src/main/services/git/sem.js"
import type { SemFacts } from "../src/main/services/git/sem.js"

const workspaceId = "workspace_test" as WorkspaceId

const change = (path: string, added: number, deleted = 0, over: Partial<GitFileChange> = {}): GitFileChange => ({
  path,
  status: "modified",
  staged: false,
  unstaged: true,
  added,
  deleted,
  isBinary: false,
  ...over,
})

const build = (changes: ReadonlyArray<GitFileChange>, sem: SemFacts | null = null) =>
  buildDiffTree({ workspaceId, changes, sem })

describe("classifyFile", () => {
  it("treats lockfiles and build output as generated wherever they sit", () => {
    expect(classifyFile("pnpm-lock.yaml", false)).toBe("generated")
    expect(classifyFile("packages/api/dist/index.js", false)).toBe("generated")
    expect(classifyFile("src/api/client.generated.ts", false)).toBe("generated")
    expect(classifyFile("tests/__snapshots__/x.snap", false)).toBe("generated")
  })

  it("prefers generated over every other kind", () => {
    // A generated test fixture is still noise, so the test signal must not win.
    expect(classifyFile("dist/thing.test.js", true)).toBe("generated")
  })

  it("believes sem's test entities over the file's location", () => {
    expect(classifyFile("src/billing/helpers.ts", true)).toBe("test")
    expect(classifyFile("src/billing/helpers.ts", false)).toBe("source")
  })

  it("reads test, schema, config and docs off conventional paths", () => {
    expect(classifyFile("src/billing/__tests__/proration.ts", false)).toBe("test")
    expect(classifyFile("src/billing/proration.test.ts", false)).toBe("test")
    expect(classifyFile("migrations/0231_credit.sql", false)).toBe("schema")
    expect(classifyFile("tsconfig.json", false)).toBe("config")
    expect(classifyFile(".gitignore", false)).toBe("config")
    expect(classifyFile("docs/billing.md", false)).toBe("docs")
    expect(classifyFile("src/billing/proration.ts", false)).toBe("source")
  })
})

describe("buildDiffTree", () => {
  it("quarantines generated files into one collapsed group at the end", () => {
    const tree = build([
      change("pnpm-lock.yaml", 9411, 8203),
      change("src/billing/proration.ts", 96, 12),
      change("dist/bundle.js", 4000, 10),
    ])

    const last = tree.groups.at(-1)
    expect(last?.kind).toBe("generated")
    expect(last?.defaultCollapsed).toBe(true)
    expect(last?.label).toBe("2 generated files")
    // The headline counts split authored from generated, so a lockfile bump
    // cannot make a two-file change look like a rewrite.
    expect(tree.stats.authoredFiles).toBe(1)
    expect(tree.stats.generatedFiles).toBe(2)
    expect(tree.groups[0]?.label).toBe("src/billing/")
  })

  it("ranks the biggest authored module first", () => {
    const tree = build([
      change("docs/notes.md", 5),
      change("src/billing/proration.ts", 96, 12),
      change("src/billing/invoice.ts", 74, 20),
    ])

    expect(tree.groups[0]?.label).toBe("src/billing/")
    // Files inside a group are ordered by weight, not alphabetically.
    expect(tree.groups[0]?.files.map((f) => f.displayPath)).toEqual(["proration.ts", "invoice.ts"])
  })

  it("places a test group directly beneath the module it covers", () => {
    // The test group is small enough that raw weight would sort it last; the
    // path-prefix attachment is what pulls it up under src/billing/.
    const tree = build([
      change("src/billing/proration.ts", 96, 12),
      change("src/billing/__tests__/proration.ts", 8),
      change("src/payments/gateway.ts", 80),
    ])

    const labels = tree.groups.map((g) => g.label)
    expect(labels.indexOf("src/billing/__tests__/")).toBe(labels.indexOf("src/billing/") + 1)
  })

  it("labels a lone schema file with its own path", () => {
    const tree = build([change("src/billing/proration.ts", 96), change("migrations/0231_credit.sql", 22)])
    const schema = tree.groups.find((g) => g.kind === "schema")
    expect(schema?.label).toBe("migrations/0231_credit.sql")
    expect(schema?.caption).toBe("Schema change — review for compatibility")
  })

  it("reports totals over every file, generated included", () => {
    const tree = build([change("pnpm-lock.yaml", 100, 50), change("src/a.ts", 10, 5)])
    expect(tree.added).toBe(110)
    expect(tree.deleted).toBe(55)
  })

  it("degrades to line counts with no sem facts", () => {
    const tree = build([change("src/a.ts", 10, 5)])
    expect(tree.semAvailable).toBe(false)
    expect(tree.groups[0]?.files[0]?.entities).toBeNull()
    expect(tree.stats.entitiesChanged).toBe(0)
  })
})

describe("buildDiffTree with sem facts", () => {
  const semFor = (changes: Parameters<typeof foldSemChanges>[0]): SemFacts => foldSemChanges(changes)

  const entity = (
    filePath: string,
    entityName: string,
    over: { changeType?: string; entityType?: string; structuralChange?: boolean | null; author?: string } = {},
  ) => ({
    entityId: `${filePath}::${entityName}`,
    changeType: over.changeType ?? "modified",
    entityType: over.entityType ?? "function",
    entityName,
    filePath,
    structuralChange: over.structuralChange ?? true,
    ...(over.author ? { author: over.author } : {}),
  })

  it("ranks a file with real entity changes above a bigger cosmetic one", () => {
    const sem = semFor([
      entity("src/app/format.ts", "formatAll", { structuralChange: false }),
      entity("src/app/core.ts", "compute", { structuralChange: true }),
    ])
    // format.ts is far larger by lines, yet nothing structural moved in it.
    const tree = build([change("src/app/format.ts", 400, 400), change("src/app/core.ts", 12, 2)], sem)

    expect(tree.groups[0]?.files.map((f) => f.displayPath)).toEqual(["core.ts", "format.ts"])
    expect(tree.stats.cosmeticOnlyFiles).toBe(1)
  })

  it("names the entities that moved, structural ones first", () => {
    const sem = semFor([
      entity("src/a.ts", "cosmeticOne", { structuralChange: false }),
      entity("src/a.ts", "realChange", { structuralChange: true }),
      entity("src/a.ts", "moduleLevel", { entityType: "orphan" }),
    ])
    const tree = build([change("src/a.ts", 10)], sem)
    const file = tree.groups[0]?.files[0]
    // `orphan` is module-level text, not a nameable entity.
    expect(file?.topEntities).toEqual(["realChange", "cosmeticOne"])
  })

  it("does not count an added entity as cosmetic", () => {
    // sem reports structuralChange: null for added/deleted entities — there is no
    // other side to compare — and a new function is the opposite of cosmetic.
    const sem = semFor([entity("src/a.ts", "brandNew", { changeType: "added", structuralChange: null })])
    const tree = build([change("src/a.ts", 30)], sem)
    const stats = tree.groups[0]?.files[0]?.entities
    expect(stats?.added).toBe(1)
    expect(stats?.cosmetic).toBe(0)
    expect(tree.stats.cosmeticOnlyFiles).toBe(0)
  })

  it("does not call a file that gained entities 'formatting only'", () => {
    // A file can hold both a new function (structuralChange: null) and a
    // reformatted one. Judging on `structural === 0` alone would mislabel it.
    const sem = semFor([
      entity("src/db/paths.ts", "newHelper", { changeType: "added", structuralChange: null }),
      entity("src/db/paths.ts", "reformatted", { structuralChange: false }),
    ])
    const tree = build([change("src/db/paths.ts", 9)], sem)
    expect(tree.stats.cosmeticOnlyFiles).toBe(0)
    expect(tree.groups[0]?.caption).not.toBe("Formatting only — safe to skim")
  })

  it("calls a genuinely reformatted group formatting-only", () => {
    const sem = semFor([entity("src/style.ts", "wrapped", { structuralChange: false })])
    const tree = build([change("src/style.ts", 40, 40)], sem)
    expect(tree.stats.cosmeticOnlyFiles).toBe(1)
    expect(tree.groups[0]?.caption).toBe("Formatting only — safe to skim")
  })

  it("classifies a file as test when sem finds test entities in it", () => {
    const sem = semFor([entity("src/billing/checks.ts", "it works", { entityType: "test" })])
    const tree = build([change("src/billing/checks.ts", 40)], sem)
    expect(tree.groups[0]?.kind).toBe("test")
  })
})
