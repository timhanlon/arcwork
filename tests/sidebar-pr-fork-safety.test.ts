import { Effect, Layer, ManagedRuntime } from "effect"
import { describe, expect, it } from "vitest"
import { ArcStore, ArcStoreLive } from "../src/main/db/store.js"
import { sqliteLayer } from "../src/main/db/sqlite.js"
import type { PullRequestRow } from "../src/main/db/schema.js"
import { arcId } from "../src/shared/ids.js"

// ArcStore over a fresh in-memory DB (migrations run on layer build); the vitest
// shim aliases better-sqlite3 → node:sqlite.
const run = async <A>(program: Effect.Effect<A, unknown, ArcStore>): Promise<A> => {
  const runtime = ManagedRuntime.make(ArcStoreLive.pipe(Layer.provide(sqliteLayer(":memory:"))))
  try {
    return await runtime.runPromise(program)
  } finally {
    await runtime.dispose()
  }
}

const repoId = arcId("repo", "repo_1")

const pr = (over: Partial<PullRequestRow> & Pick<PullRequestRow, "id" | "number">): PullRequestRow => ({
  repositoryId: repoId,
  githubNodeId: null,
  title: `PR ${over.number}`,
  body: "",
  state: "open",
  isDraft: 0,
  author: "octocat",
  headRef: "feat",
  headSha: null,
  headRepositoryOwner: "acme",
  headRepositoryName: "widgets",
  baseRef: "main",
  reviewState: null,
  checksState: null,
  mergeable: null,
  mergeStateStatus: null,
  url: null,
  lastSyncedAt: "2026-06-08T00:00:00.000Z",
  createdAt: "2026-06-08T00:00:00.000Z",
  updatedAt: "2026-06-08T00:00:00.000Z",
  ...over,
})

const upsertWidgetsRepo = Effect.gen(function* () {
  const db = yield* ArcStore
  yield* db.upsertRepository({
    id: repoId,
    commonGitDir: "/tmp/widgets/.git",
    rootPath: "/tmp/widgets",
    defaultBranch: "main",
    remotesJson: "[]",
    githubOwner: "acme",
    githubRepo: "widgets",
    githubNodeId: null,
    createdAt: "2026-06-08T00:00:00.000Z",
    lastSeenAt: "2026-06-08T00:00:00.000Z",
  })
})

describe("loadSidebarPullRequests fork safety", () => {
  it("excludes a fork PR that reused a local branch name", async () => {
    const numbers = await run(
      Effect.gen(function* () {
        const db = yield* ArcStore
        yield* upsertWidgetsRepo
        // Same branch name "feat" from the repo itself vs. a fork; only the
        // repo's own head should map onto the sidebar.
        yield* db.upsertPullRequest(pr({ id: arcId("pr", "pr_local"), number: 1 }))
        yield* db.upsertPullRequest(
          pr({ id: arcId("pr", "pr_fork"), number: 2, headRepositoryOwner: "forkuser" }),
        )
        // A row synced before the head-repo columns existed (NULL) is also a fork
        // risk → excluded by the owner/name join.
        yield* db.upsertPullRequest(
          pr({ id: arcId("pr", "pr_legacy"), number: 3, headRepositoryOwner: null, headRepositoryName: null }),
        )
        const rows = yield* db.loadSidebarPullRequests
        return rows.map((row) => row.number)
      }),
    )
    expect(numbers).toEqual([1])
  })
})
