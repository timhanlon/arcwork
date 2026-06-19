import { useAtomValue } from "@effect/atom-react"
import { useEffect, useState } from "react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { WorkCommentListing } from "../../../shared/work.js"
import { workCommentsAtomFor } from "../atoms.js"

/** The empty listing shown before the first fetch resolves (or for no selection). */
const EMPTY: WorkCommentListing = { currentNodeId: "", comments: [], olderRevisionCommentCount: 0 }

const emptyCommentsAtom = Atom.make(AsyncResult.success<WorkCommentListing>(EMPTY))

/**
 * A selected work item's comments, fetched over the RPC seam from
 * `WorkService.listComments`.
 *
 * `allRevisions` toggles between the default view (current-revision node comments
 * plus ref comments) and every comment across revisions; flipping it is a
 * distinct keyed query (with its own cached value). Switching `workId` resets the
 * toggle back to the default so a new item never opens already expanded. Backed
 * by {@link workCommentsAtomFor}, refreshed on the shared work invalidation
 * signal — the in-app `arc:work` push plus a coarse chat-activity fallback.
 */
export function useWorkComments(workId: string | undefined): {
  readonly listing: WorkCommentListing
  readonly loading: boolean
  readonly allRevisions: boolean
  readonly setAllRevisions: (v: boolean) => void
} {
  const [allRevisions, setAllRevisions] = useState(false)

  // A fresh selection always starts collapsed to the current-revision view.
  useEffect(() => {
    setAllRevisions(false)
  }, [workId])

  const result = useAtomValue(
    workId ? workCommentsAtomFor(workId, allRevisions) : emptyCommentsAtom,
  )

  return {
    listing: AsyncResult.isSuccess(result) ? result.value : EMPTY,
    loading: !AsyncResult.isSuccess(result),
    allRevisions,
    setAllRevisions,
  }
}
