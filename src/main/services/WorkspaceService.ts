import { Context, Effect, Layer, type Stream, SubscriptionRef } from "effect"
import { dialog } from "electron"
import * as path from "node:path"
import type { SqlError } from "effect/unstable/sql/SqlError"
import type { Workspace } from "../../shared/workspace.js"
import { ArcStore } from "../db/store.js"
import type { WorkspaceRow } from "../db/schema.js"
import { newArcId } from "../../shared/ids.js"
import { nowIso } from "../clock.js"

/**
 * Owns the persisted workspace list — filesystem roots that scope chats and
 * supply cwd for launched targets. Multiple workspaces are visible concurrently;
 * there is no single "active" workspace.
 */
export class WorkspaceService extends Context.Service<
  WorkspaceService,
  {
    readonly list: Effect.Effect<ReadonlyArray<Workspace>>
    readonly changes: Stream.Stream<ReadonlyArray<Workspace>>
    readonly open: Effect.Effect<Workspace | undefined, SqlError>
    /** Register (or refresh) a workspace at an explicit directory — the no-dialog
     * sibling of {@link open}, used to open an arc-created worktree as a
     * workspace. Idempotent on path. */
    readonly openAt: (dir: string) => Effect.Effect<Workspace, SqlError>
  }
>()("WorkspaceService") {}

const rowToWorkspace = (row: WorkspaceRow): Workspace => ({
  id: row.id,
  path: row.path,
  name: row.name,
})

export const WorkspaceServiceLive = Layer.effect(
  WorkspaceService,
  Effect.gen(function* () {
    const db = yield* ArcStore

    const rows = yield* db.loadWorkspaces.pipe(
      Effect.tapError((e) => Effect.logWarning(`workspace load failed; starting empty: ${e}`)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<WorkspaceRow>),
    )
    const initial = rows.map(rowToWorkspace)

    const store = yield* SubscriptionRef.make(initial)

    const upsertByPath = Effect.fn("WorkspaceService.upsertByPath")((dir: string) =>
      Effect.gen(function* () {
        const resolved = path.resolve(dir)
        const now = yield* nowIso
        const row = yield* db.upsertWorkspace({
          id: newArcId("workspace"),
          path: resolved,
          name: path.basename(resolved),
          createdAt: now,
          lastOpenedAt: now,
        })
        const workspace = rowToWorkspace(row)
        yield* SubscriptionRef.update(store, (workspaces) => {
          const without = workspaces.filter((w) => w.path !== resolved)
          return [workspace, ...without]
        })
        return workspace
      }).pipe(
        Effect.withSpan("arc.workspace.upsert", {
          attributes: {
            "arc.workspace_path": path.resolve(dir),
          },
        }),
      ),
    )

    const list = SubscriptionRef.get(store)
    const changes = SubscriptionRef.changes(store)

    const open = Effect.gen(function* () {
      const result = yield* Effect.promise(() =>
        dialog.showOpenDialog({
          properties: ["openDirectory", "createDirectory"],
        }),
      )
      if (result.canceled || result.filePaths.length === 0) return undefined
      return yield* upsertByPath(result.filePaths[0]!)
    }).pipe(Effect.withSpan("arc.workspace.open_dialog"))

    return { list, changes, open, openAt: upsertByPath }
  }),
)
