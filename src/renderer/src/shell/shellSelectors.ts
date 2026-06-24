import type { Chat } from "../../../shared/chat.js"
import type { ChatId, TargetId, WorkId, WorkspaceId } from "../../../shared/ids.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { Workspace } from "../../../shared/workspace.js"
import type { ArcShellContext } from "./arcShellMachine.js"

// Pure projections of shell state onto the server data the renderer holds. These
// live here, not in App, so the component stops owning derived shell state — the
// selection/runtime in the machine plus the reactive atoms are the only inputs,
// and everything App needs to render falls out of `deriveShellViewModel`.

export interface ShellServerData {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
}

export interface ShellViewModel {
  readonly workspaceId?: WorkspaceId
  readonly chatId?: ChatId
  readonly workspace?: Workspace
  readonly chat?: Chat
  /** The workspace owning the selected chat — may differ from `workspace`. */
  readonly chatWorkspace?: Workspace
  readonly sessionCount: number
  readonly activeSessionId?: TargetId
  /** A restored, not-attached session to surface a resume prompt for, if any. */
  readonly detachedSession?: TargetSession
  readonly gitPath?: string
  /** The work item selected in the center navigator, remembered per workspace. */
  readonly workId?: WorkId
}

export const deriveShellViewModel = (
  context: ArcShellContext,
  { workspaces, chats, sessions }: ShellServerData,
): ShellViewModel => {
  const { selection, panes } = context

  // Guard each picked id against the live lists: a persisted (or in-session)
  // selection can outlive the chat/workspace it names, so an unknown id falls
  // through to the next default rather than stranding the pane on nothing.
  const persistedWorkspace =
    selection.workspaceId && workspaces.some((w) => w.id === selection.workspaceId)
      ? selection.workspaceId
      : undefined
  const workspaceId = persistedWorkspace ?? workspaces[0]?.id
  const workspaceChats = workspaceId
    ? chats.filter((chat) => chat.workspaceId === workspaceId)
    : []
  const chatExists = (id: ChatId | undefined): id is ChatId =>
    id !== undefined && chats.some((chat) => chat.id === id)
  const mappedChat = workspaceId ? selection.chatByWorkspace[workspaceId] : undefined
  const chatId =
    (chatExists(selection.chatId) ? selection.chatId : undefined) ??
    (chatExists(mappedChat) ? mappedChat : undefined) ??
    workspaceChats[0]?.id

  const chat = chatId ? chats.find((candidate) => candidate.id === chatId) : undefined
  const workspace = workspaceId
    ? workspaces.find((candidate) => candidate.id === workspaceId)
    : undefined
  const chatWorkspace = chat
    ? workspaces.find((candidate) => candidate.id === chat.workspaceId)
    : undefined

  const activeSessionId = panes.find((pane) => pane.id === selection.terminalPaneId)?.sessionId

  // A detached session can be surfaced two ways: a focus intent the machine
  // recorded, or a not-attached session the user simply selected in the tree.
  const machineDetached = context.detachedSessionId
    ? sessions.find((s) => s.id === context.detachedSessionId && !s.attached)
    : undefined
  const selectedDetached = selection.sessionId
    ? sessions.find((s) => s.id === selection.sessionId && !s.attached)
    : undefined

  return {
    workspaceId,
    chatId,
    workspace,
    chat,
    chatWorkspace,
    sessionCount: chatId ? sessions.filter((s) => s.chatId === chatId).length : 0,
    activeSessionId,
    detachedSession: machineDetached ?? selectedDetached,
    gitPath: workspaceId ? selection.gitPathByWorkspace[workspaceId] : undefined,
    workId: workspaceId ? selection.workByWorkspace[workspaceId] : undefined,
  }
}
