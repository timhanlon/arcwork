import { useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import * as Atom from "effect/unstable/reactivity/Atom"
import type { ActivityEvent } from "../../../shared/activity-event.js"
import { chatActivityAtom } from "../atoms.js"

const emptyChatActivityAtom = Atom.make(
  AsyncResult.success<ReadonlyArray<ActivityEvent>>([]),
)

export function useChatActivity(chatId: string | undefined): ReadonlyArray<ActivityEvent> {
  const result = useAtomValue(chatId ? chatActivityAtom(chatId) : emptyChatActivityAtom)
  return AsyncResult.isSuccess(result) ? result.value : []
}
