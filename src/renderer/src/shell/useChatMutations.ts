import { useCallback } from "react"
import { useAtomSet } from "@effect/atom-react"
import { Exit } from "effect"
import { createChatAtom } from "../atoms.js"
import { rpc } from "../rpc-client.js"
import type { ChatId, WorkspaceId } from "../../../shared/ids.js"

export interface ChatMutations {
  /** Create a chat in a workspace and select it on success (a failed create
   * lands in the atom's AsyncResult and leaves the selection untouched). */
  readonly createChat: (workspaceId: WorkspaceId) => Promise<void>
  readonly renameChat: (chatId: ChatId, title: string) => Promise<void>
}

/**
 * The two chat-row mutations shared by App and the sidebar. `selectChat` is
 * passed in rather than read from the ShellActions context because App lives
 * *above* the provider it renders (so the context isn't visible to it), while
 * the sidebar reads the same action from context — both hand the identical
 * callback here, so the create-then-select sequence lives in one place.
 */
export const useChatMutations = (
  selectChat: (workspaceId: WorkspaceId, chatId: ChatId) => void,
): ChatMutations => {
  const runCreateChat = useAtomSet(createChatAtom, { mode: "promiseExit" })
  const createChat = useCallback(
    async (workspaceId: WorkspaceId): Promise<void> => {
      const exit = await runCreateChat({ payload: { workspaceId } })
      if (Exit.isSuccess(exit)) selectChat(workspaceId, exit.value.id)
    },
    [runCreateChat, selectChat],
  )
  const renameChat = useCallback(async (chatId: ChatId, title: string): Promise<void> => {
    await rpc("UpdateChatTitle", { chatId, title })
  }, [])
  return { createChat, renameChat }
}
