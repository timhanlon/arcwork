import { useAtomValue } from "@effect/atom-react"
import { Option } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { GitCommit, GitStatus, WorkspaceGitContext } from "../../../shared/git.js"
import type { WorkspaceId } from "../../../shared/ids.js"
import { gitCommitsAtom, gitContextAtom, gitStatusAtom } from "../atoms.js"

const errorMessage = <E extends { readonly message: string }>(
  result: AsyncResult.AsyncResult<unknown, E>,
): string | undefined =>
  Option.match(AsyncResult.error(result), { onNone: () => undefined, onSome: (e) => e.message })

export interface WorkspaceGit {
  readonly status?: GitStatus
  readonly context?: WorkspaceGitContext
  readonly commits: ReadonlyArray<GitCommit>
  /** First-pull state for the change list (no status value yet). */
  readonly loading: boolean
  /** First-pull state for the commit list (no commits value yet). */
  readonly commitsLoading: boolean
  readonly error?: string
}

/**
 * The workspace's git read model — status, repo/PR context, and branch commits —
 * read from the shared, signal-refreshed atoms. Because the atoms live outside the
 * Git pane, the data survives the pane's mount/unmount and is already warm when a
 * subscriber (the prefetch) has kept it live. Refreshes retain the prior value, so
 * `loading` is true only on the very first pull.
 */
export function useWorkspaceGit(workspaceId: WorkspaceId): WorkspaceGit {
  const statusResult = useAtomValue(gitStatusAtom(workspaceId))
  const contextResult = useAtomValue(gitContextAtom(workspaceId))
  const commitsResult = useAtomValue(gitCommitsAtom(workspaceId))
  return {
    status: AsyncResult.isSuccess(statusResult) ? statusResult.value : undefined,
    context: AsyncResult.isSuccess(contextResult) ? contextResult.value : undefined,
    commits: AsyncResult.isSuccess(commitsResult) ? commitsResult.value : [],
    loading: !AsyncResult.isSuccess(statusResult),
    commitsLoading: !AsyncResult.isSuccess(commitsResult),
    error: errorMessage(statusResult) ?? errorMessage(commitsResult),
  }
}
