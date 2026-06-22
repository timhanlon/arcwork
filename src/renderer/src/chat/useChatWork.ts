import { useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { Work } from "../../../shared/work.js"
import type { ChatId } from "../../../shared/ids.js"
import { chatWorkAtom } from "../atoms.js"

/**
 * The work authored in a given chat, scoped to context — what the chat pane
 * shows so "the work from this chat" is visible alongside the conversation.
 *
 * Fetches through the typed AtomRpc query path and re-pulls on the shared work
 * invalidation signal, so the list stays live with no manual refresh.
 */
const emptyChatWorkAtom = Atom.make(AsyncResult.success<ReadonlyArray<Work>>([]))

export function useChatWork(
  chatId: ChatId | undefined,
): { readonly work: ReadonlyArray<Work> } {
  const atom = chatId ? chatWorkAtom(chatId) : emptyChatWorkAtom
  const result = useAtomValue(atom)
  return { work: AsyncResult.isSuccess(result) ? result.value : [] }
}
