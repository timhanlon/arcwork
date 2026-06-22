import { useAtomRefresh, useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { Work } from "../../../shared/work.js"
import type { ChatId } from "../../../shared/ids.js"
import { allWorkAtom } from "../atoms.js"

/**
 * Every unit of work in the selected chat's workspace, across all statuses —
 * what the work navigator lists, then filters by status client-side.
 *
 * Backed by {@link allWorkAtom}: a composite typed read (search + hydrate)
 * refreshed by the shared work invalidation signal (the in-app `arc:work` push
 * plus a coarse chat-activity fallback).
 * Refreshes are quiet — the atom retains the prior value while re-pulling, so
 * the list never flashes empty. `loading` is the first-pull state only (it
 * drives the empty-list placeholder); `reload` re-pulls immediately after the
 * pane's own mutations.
 */
const emptyWorkAtom = Atom.make(AsyncResult.success<ReadonlyArray<Work>>([]))

export function useAllWork(chatId: ChatId | undefined): {
  readonly work: ReadonlyArray<Work>
  readonly loading: boolean
  readonly reload: () => void
} {
  const atom = chatId ? allWorkAtom(chatId) : emptyWorkAtom
  const result = useAtomValue(atom)
  const reload = useAtomRefresh(atom)
  return {
    work: AsyncResult.isSuccess(result) ? result.value : [],
    loading: !AsyncResult.isSuccess(result),
    reload,
  }
}
