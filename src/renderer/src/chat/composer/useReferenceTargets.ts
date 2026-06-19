import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import type { TargetSession } from "../../../../shared/instance.js"
import type { Work } from "../../../../shared/work.js"
import { listWorkspaceFilesAtom } from "../../atoms.js"
import {
  type ReferenceCandidate,
  fileCandidates,
  sessionCandidates,
  workCandidates,
} from "./references.js"

/**
 * Assembles the unified candidate list for the composer's `@` picker: work
 * authored in this chat and the chat's sessions (both already in memory), plus
 * the workspace's files — fetched lazily over the RPC seam the first time the
 * picker opens, then cached for the workspace. Ordered work → files → sessions
 * so a bare `@` surfaces the chat's own work first, with files (the largest set)
 * behind it and sessions last.
 */
export function useReferenceTargets(args: {
  readonly work: ReadonlyArray<Work>
  readonly sessions: ReadonlyArray<TargetSession>
  readonly workspaceId?: string
}): {
  readonly candidates: ReadonlyArray<ReferenceCandidate>
  readonly ensureFilesLoaded: () => void
  readonly filesTruncated: boolean
} {
  const { work, sessions, workspaceId } = args
  const [files, setFiles] = useState<ReadonlyArray<string>>([])
  const [filesTruncated, setFilesTruncated] = useState(false)
  // The workspace whose files we've already fetched, so we load once per
  // workspace and refetch when the chat moves to a different one.
  const loadedFor = useRef<string | undefined>(undefined)

  // Drop a stale file list immediately when the workspace changes; the next
  // picker-open refetches for the new root.
  useEffect(() => {
    if (loadedFor.current !== workspaceId) {
      loadedFor.current = undefined
      setFiles([])
      setFilesTruncated(false)
    }
  }, [workspaceId])

  const loadFiles = useAtomSet(listWorkspaceFilesAtom, { mode: "promiseExit" })

  const ensureFilesLoaded = useCallback((): void => {
    if (!workspaceId || loadedFor.current === workspaceId) return
    loadedFor.current = workspaceId
    void loadFiles({ payload: { workspaceId } }).then((exit) => {
      if (Exit.isSuccess(exit)) {
        setFiles(exit.value.files)
        setFilesTruncated(exit.value.truncated)
      } else {
        // A failed load just means no file candidates this session — work and
        // sessions still populate the picker. Re-arm so a later open retries.
        loadedFor.current = undefined
      }
    })
  }, [workspaceId, loadFiles])

  const candidates = useMemo(
    (): ReadonlyArray<ReferenceCandidate> => [
      ...workCandidates(work),
      ...fileCandidates(files),
      ...sessionCandidates(sessions),
    ],
    [work, files, sessions],
  )

  return { candidates, ensureFilesLoaded, filesTruncated }
}
