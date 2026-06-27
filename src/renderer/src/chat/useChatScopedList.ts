import { useAtomValue } from "@effect/atom-react"
import type * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type * as Atom from "effect/unstable/reactivity/Atom"
import type { ChatId } from "../../../shared/ids.js"
import { emptyListAtom, successList } from "../atoms.js"

/**
 * Read a chat-scoped list atom family for the selected chat, falling back to a
 * shared empty list when nothing is selected. Centralises the
 * "pick atom-or-empty → unwrap AsyncResult" shape the per-list chat hooks share.
 */
export function useChatScopedList<A>(
  family: (chatId: ChatId) => Atom.Atom<AsyncResult.AsyncResult<ReadonlyArray<A>, unknown>>,
  chatId: ChatId | undefined,
): ReadonlyArray<A> {
  return successList(useAtomValue(chatId ? family(chatId) : emptyListAtom))
}
