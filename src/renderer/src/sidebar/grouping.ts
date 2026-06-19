import type { Workspace } from "../../../shared/workspace.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { LiveTargetActivity } from "../../../shared/live-target-state.js"
import type { SessionDisplayStatus } from "./row-styles.js"

/** session id → its live activity, from the `arc:live-target-states` projection. */
export type LiveStateById = ReadonlyMap<string, LiveTargetActivity>

/**
 * The live activity of a session before the projection has loaded (or for a
 * session the projection hasn't caught up to). Never guesses "generating" — only
 * the hook turn lifecycle can say that — so an attached session rests at "idle"
 * until the main process pushes its real activity.
 */
export const fallbackActivity = (session: TargetSession): LiveTargetActivity =>
  session.state === "exited" ? "exited" : session.attached === true ? "idle" : "detached"

/** The projection's activity for a session, falling back when it's absent. */
export const liveActivityFor = (
  session: TargetSession,
  liveStateById: LiveStateById,
): LiveTargetActivity => liveStateById.get(session.id) ?? fallbackActivity(session)

export interface WorkspaceGroup {
  readonly workspace: Workspace
  readonly chats: ReadonlyArray<Chat>
  readonly sessionsByChat: ReadonlyMap<string, ReadonlyArray<TargetSession>>
}

/**
 * Collapse a session's live activity into the single word a row displays. The
 * currently focused session reads "active" (its focus halo), but only while it's
 * actually live: a dead session (`exited`/`detached`) always shows its dead state
 * even when selected, so stopping the last target in a chat doesn't leave a blue
 * "active" halo on a session that's gone. (Row selection is still cued by the
 * row's own active styling, and the pending pip flags a waiting session.)
 */
export function sessionStatus(activity: LiveTargetActivity, isActive: boolean): SessionDisplayStatus {
  if (activity === "exited" || activity === "detached") return activity
  return isActive ? "active" : activity
}

/**
 * Bucket flat workspace/chat/session arrays into the nested shape the tree
 * renders: chats grouped under their workspace (newest first), and a single
 * chatId → sessions index shared across groups.
 */
export function groupSidebarData(
  workspaces: ReadonlyArray<Workspace>,
  chats: ReadonlyArray<Chat>,
  sessions: ReadonlyArray<TargetSession>,
): ReadonlyArray<WorkspaceGroup> {
  const chatsByWorkspace = new Map<string, Array<Chat>>()
  const sessionsByChat = new Map<string, Array<TargetSession>>()

  for (const chat of chats) {
    const bucket = chatsByWorkspace.get(chat.workspaceId) ?? []
    bucket.push(chat)
    chatsByWorkspace.set(chat.workspaceId, bucket)
  }
  for (const session of sessions) {
    const bucket = sessionsByChat.get(session.chatId) ?? []
    bucket.push(session)
    sessionsByChat.set(session.chatId, bucket)
  }

  return workspaces.map((workspace) => ({
    workspace,
    chats: [...(chatsByWorkspace.get(workspace.id) ?? [])].sort((a, b) =>
      b.createdAt.localeCompare(a.createdAt),
    ),
    sessionsByChat,
  }))
}

/**
 * The session ids awaiting the user, in the exact top-to-bottom order the tree
 * paints them. This is what the ⌘1…⌘9 "jump to request" shortcuts index into,
 * so ⌘1 is always the topmost waiting session and the numeric hint on each row
 * matches the key that focuses it.
 */
export function orderedPendingSessionIds(
  workspaces: ReadonlyArray<Workspace>,
  chats: ReadonlyArray<Chat>,
  sessions: ReadonlyArray<TargetSession>,
  pendingSessionIds: ReadonlySet<string>,
): ReadonlyArray<string> {
  const ordered: Array<string> = []
  for (const { chats: chatGroup, sessionsByChat } of groupSidebarData(workspaces, chats, sessions)) {
    for (const chat of chatGroup) {
      for (const session of sessionsByChat.get(chat.id) ?? []) {
        if (pendingSessionIds.has(session.id)) ordered.push(session.id)
      }
    }
  }
  return ordered
}
