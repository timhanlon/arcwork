import type { Work } from "../../../shared/work.js"
import type { ChatId } from "../../../shared/ids.js"
import { chatWorkAtom } from "../atoms.js"
import { useChatScopedList } from "./useChatScopedList.js"

/**
 * The work authored in a given chat, scoped to context — what the chat pane
 * shows so "the work from this chat" is visible alongside the conversation.
 *
 * Fetches through the typed AtomRpc query path and re-pulls on the shared work
 * invalidation signal, so the list stays live with no manual refresh.
 */
export function useChatWork(
  chatId: ChatId | undefined,
): { readonly work: ReadonlyArray<Work> } {
  return { work: useChatScopedList(chatWorkAtom, chatId) }
}
