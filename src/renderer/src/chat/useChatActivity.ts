import type { ActivityEvent } from "../../../shared/activity-event.js"
import type { ChatId } from "../../../shared/ids.js"
import { chatActivityAtom } from "../atoms.js"
import { useChatScopedList } from "./useChatScopedList.js"

export function useChatActivity(chatId: ChatId | undefined): ReadonlyArray<ActivityEvent> {
  return useChatScopedList(chatActivityAtom, chatId)
}
