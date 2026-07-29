import type { DiffEntityStats, DiffTree as DiffTreeModel, DiffTreeFile, DiffTreeGroup } from "../../../shared/git.js"
import { arcId } from "../../../shared/ids.js"
import { DiffTree } from "./DiffTree.js"

export default {
  title: "Git / DiffTree",
}

const workspaceId = arcId("workspace", "workspace_1")

const entities = (over: Partial<DiffEntityStats> = {}): DiffEntityStats => ({
  added: 0,
  modified: 0,
  removed: 0,
  moved: 0,
  structural: 0,
  cosmetic: 0,
  ...over,
})

const file = (
  displayPath: string,
  added: number,
  deleted: number,
  over: Partial<DiffTreeFile> = {},
): DiffTreeFile => ({
  path: `src/billing/${displayPath}`,
  displayPath,
  originalPath: null,
  status: "modified",
  kind: "source",
  added,
  deleted,
  isBinary: false,
  entities: null,
  topEntities: [],
  ...over,
})

const group = (over: Partial<DiffTreeGroup> & Pick<DiffTreeGroup, "id" | "label">): DiffTreeGroup => ({
  caption: null,
  kind: "source",
  added: 0,
  deleted: 0,
  entitiesChanged: 0,
  defaultCollapsed: false,
  files: [],
  ...over,
})

const tree = (over: Partial<DiffTreeModel> = {}): DiffTreeModel => ({
  workspaceId,
  added: 414,
  deleted: 60,
  semAvailable: true,
  stats: {
    modules: 2,
    authoredFiles: 9,
    generatedFiles: 3,
    entitiesChanged: 42,
    cosmeticOnlyFiles: 0,
  },
  groups: [],
  ...over,
})

/** The reference shape: a core module, its tests, a migration, and a collapsed
 * generated bucket whose 9k lines sit outside the authored-file count. */
export const Default = () => (
  <div className="w-full max-w-[680px] bg-background">
    <DiffTree
      tree={tree({
        groups: [
          group({
            id: "src/billing/ source",
            label: "src/billing/",
            added: 212,
            deleted: 38,
            entitiesChanged: 24,
            files: [
              file("proration.ts", 96, 12, {
                entities: entities({ added: 3, modified: 5, structural: 7 }),
                topEntities: ["applyProration", "creditFor", "ProrationInput"],
              }),
              file("invoice.ts", 74, 20, {
                entities: entities({ modified: 6, structural: 6 }),
                topEntities: ["buildInvoice", "lineItems"],
              }),
              file("types.ts", 34, 4, { entities: entities({ added: 4, structural: 1 }) }),
              file("index.ts", 8, 2, { entities: entities({ modified: 1, structural: 1 }) }),
            ],
          }),
          group({
            id: "src/billing/__tests__/ test",
            label: "src/billing/__tests__/",
            caption: "18 test entities touched",
            kind: "test",
            added: 180,
            deleted: 0,
            entitiesChanged: 18,
            files: [
              file("proration.test.ts", 180, 0, {
                path: "src/billing/__tests__/proration.test.ts",
                displayPath: "proration.test.ts",
                kind: "test",
                status: "added",
                entities: entities({ added: 18 }),
                topEntities: ["prorates a mid-cycle upgrade", "credits a downgrade"],
              }),
            ],
          }),
          group({
            id: "migrations/ schema",
            label: "migrations/0231_credit.sql",
            caption: "Schema change — review for compatibility",
            kind: "schema",
            added: 22,
            deleted: 0,
            files: [
              file("0231_credit.sql", 22, 0, {
                path: "migrations/0231_credit.sql",
                displayPath: "0231_credit.sql",
                kind: "schema",
                status: "added",
              }),
            ],
          }),
          group({
            id: "generated",
            label: "3 generated files",
            caption: "pnpm-lock.yaml, openapi-client.ts and 1 more — collapsed by default",
            kind: "generated",
            added: 9411,
            deleted: 8203,
            defaultCollapsed: true,
            files: [
              file("pnpm-lock.yaml", 1204, 403, {
                path: "pnpm-lock.yaml",
                displayPath: "pnpm-lock.yaml",
                kind: "generated",
              }),
              file("openapi-client.ts", 8000, 7800, {
                path: "src/api/openapi-client.generated.ts",
                displayPath: "openapi-client.generated.ts",
                kind: "generated",
              }),
              file("schema.snap", 207, 0, {
                path: "tests/__snapshots__/schema.snap",
                displayPath: "schema.snap",
                kind: "generated",
              }),
            ],
          }),
        ],
      })}
    />
  </div>
)

/** Without the `sem` binary there are no entity counts — the tree still groups
 * and quarantines, it just falls back to line counts and drops the entity line. */
export const WithoutSem = () => (
  <div className="w-full max-w-[680px] bg-background">
    <DiffTree
      tree={tree({
        semAvailable: false,
        stats: { modules: 1, authoredFiles: 2, generatedFiles: 1, entitiesChanged: 0, cosmeticOnlyFiles: 0 },
        added: 170,
        deleted: 32,
        groups: [
          group({
            id: "src/billing/ source",
            label: "src/billing/",
            added: 170,
            deleted: 32,
            files: [file("proration.ts", 96, 12), file("invoice.ts", 74, 20)],
          }),
          group({
            id: "generated",
            label: "1 generated file",
            caption: "pnpm-lock.yaml — collapsed by default",
            kind: "generated",
            added: 1204,
            deleted: 403,
            defaultCollapsed: true,
            files: [
              file("pnpm-lock.yaml", 1204, 403, {
                path: "pnpm-lock.yaml",
                displayPath: "pnpm-lock.yaml",
                kind: "generated",
              }),
            ],
          }),
        ],
      })}
    />
  </div>
)

/** The signal that saves the most time: a big-looking change that is only
 * reformatting. Lines say 400; the entity pass says nothing structural moved. */
export const FormattingOnly = () => (
  <div className="w-full max-w-[680px] bg-background">
    <DiffTree
      tree={tree({
        added: 402,
        deleted: 398,
        stats: { modules: 1, authoredFiles: 2, generatedFiles: 0, entitiesChanged: 14, cosmeticOnlyFiles: 2 },
        groups: [
          group({
            id: "src/billing/ source",
            label: "src/billing/",
            caption: "Formatting only — safe to skim",
            added: 402,
            deleted: 398,
            entitiesChanged: 14,
            files: [
              file("invoice.ts", 210, 208, { entities: entities({ modified: 8, cosmetic: 8 }) }),
              file("proration.ts", 192, 190, { entities: entities({ modified: 6, cosmetic: 6 }) }),
            ],
          }),
        ],
      })}
    />
  </div>
)

/** The 100k-diff case the tree exists to warn about — many modules and files. */
export const LargePullRequest = () => (
  <div className="w-full max-w-[680px] bg-background">
    <DiffTree
      tree={tree({
        added: 41_882,
        deleted: 12_004,
        stats: {
          modules: 18,
          authoredFiles: 143,
          generatedFiles: 11,
          entitiesChanged: 1204,
          cosmeticOnlyFiles: 22,
        },
        groups: Array.from({ length: 6 }, (_, index) =>
          group({
            id: `src/module-${index}/ source`,
            label: `src/module-${index}/`,
            caption: null,
            added: 4000 - index * 400,
            deleted: 1200 - index * 100,
            entitiesChanged: 200 - index * 20,
            files: [
              file("service.ts", 900 - index * 80, 200, {
                path: `src/module-${index}/service.ts`,
                entities: entities({ added: 12, modified: 20, structural: 24 }),
                topEntities: ["handleRequest", "normalize"],
              }),
              file("store.ts", 400 - index * 30, 90, {
                path: `src/module-${index}/store.ts`,
                entities: entities({ modified: 9, structural: 9 }),
              }),
            ],
          }),
        ),
      })}
    />
  </div>
)

export const NoChanges = () => (
  <div className="w-full max-w-[680px] bg-background">
    <DiffTree tree={tree({ added: 0, deleted: 0, groups: [] })} />
  </div>
)
