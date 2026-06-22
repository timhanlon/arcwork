import { useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { ChatMessage } from "../../../shared/chat-message.js"
import type { ChatId } from "../../../shared/ids.js"
import { chatMessagesAtom } from "../atoms.js"

const emptyChatMessagesAtom = Atom.make(
  AsyncResult.success<ReadonlyArray<ChatMessage>>([]),
)

export function useChatMessages(chatId: ChatId | undefined): ReadonlyArray<ChatMessage> {
  const result = useAtomValue(chatId ? chatMessagesAtom(chatId) : emptyChatMessagesAtom)
  return AsyncResult.isSuccess(result) ? result.value : []
}
