import { type JSX, useEffect, useState } from "react"
import { useAtomRefresh } from "@effect/atom-react"
import type { WorkspaceId } from "../../../shared/ids.js"
import { gitCommitsAtom, gitContextAtom } from "../atoms.js"
import { rpc } from "../rpc-client.js"
import { useWorkspaceGit } from "./useWorkspaceGit.js"

// Workspaces whose PRs have been synced this session. The GitHub sync is the one
// network read here; once per workspace per session is plenty — git hooks
// (pre-push) keep it fresh after that.
const syncedThisSession = new Set<string>()

// Settle delay before warming a workspace's git data. Switching workspaces is on
// the critical path (chats, sessions, messages all reload); deferring the git
// reads past this window keeps switching snappy and skips warming workspaces the
// user only passes through.
const WARM_DELAY_MS = 400

/**
 * Keeps the active workspace's git atoms warm so the Git pane opens already
 * populated — no cold fetch, no load flash. It debounces on the workspace: only
 * once you settle on one for {@link WARM_DELAY_MS} does it subscribe the
 * status/context/commits atoms (holding them live while the pane is closed) and
 * pull fresh PRs. Rapid switching does no git work at all. Renders nothing.
 */
export function GitPrefetch({ workspaceId }: { readonly workspaceId: WorkspaceId }): JSX.Element | null {
  const [warmId, setWarmId] = useState<WorkspaceId | undefined>(undefined)

  useEffect(() => {
    const timer = setTimeout(() => setWarmId(workspaceId), WARM_DELAY_MS)
    return () => clearTimeout(timer)
  }, [workspaceId])

  return warmId === workspaceId ? <GitWarm workspaceId={workspaceId} /> : null
}

function GitWarm({ workspaceId }: { readonly workspaceId: WorkspaceId }): null {
  useWorkspaceGit(workspaceId)
  const refreshContext = useAtomRefresh(gitContextAtom(workspaceId))
  const refreshCommits = useAtomRefresh(gitCommitsAtom(workspaceId))

  useEffect(() => {
    if (syncedThisSession.has(workspaceId)) return
    syncedThisSession.add(workspaceId)
    let cancelled = false
    rpc("SyncWorkspacePullRequests", { workspaceId })
      .then(() => {
        if (cancelled) return
        // Sync runs detectRepository, which populates the workspace's branch and
        // default branch. The commits atom scopes its `base..HEAD` range by those,
        // so if it first loaded before detection it's stuck on full history —
        // re-pull it (detection refreshes the workspace list but emits no git
        // change signal, by design, so the atom won't refresh on its own).
        refreshContext()
        refreshCommits()
      })
      .catch(() => {
        syncedThisSession.delete(workspaceId)
      })
    return () => {
      cancelled = true
    }
  }, [workspaceId, refreshContext, refreshCommits])

  return null
}
