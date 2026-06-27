import type { ChatMessage } from "../../../shared/chat-message.js"
import type { ChatId } from "../../../shared/ids.js"
import { chatMessagesAtom } from "../atoms.js"
import { useChatScopedList } from "./useChatScopedList.js"

export function useChatMessages(chatId: ChatId | undefined): ReadonlyArray<ChatMessage> {
  return useChatScopedList(chatMessagesAtom, chatId)
}
