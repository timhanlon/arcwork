import type { Workspace } from "../../../shared/workspace.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { ChatId, TargetId } from "../../../shared/ids.js"
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
 * A project tier over workspace groups. A repository-backed project (`repositoryId`
 * set) collects every workspace sharing that repo — its main checkout plus any
 * worktrees — under one header (`label`). A plain folder has `repositoryId` null,
 * is its own single-member project, and renders with no header. Order follows
 * each project's first appearance in the workspace list.
 */
export interface ProjectGroup {
  readonly key: string
  readonly repositoryId: string | null
  readonly label: string
  readonly defaultBranch: string | null
  readonly members: ReadonlyArray<WorkspaceGroup>
}

/** Bucket workspace groups under their repository. Members of a repo project are
 * ordered main-checkout-first, then worktrees by branch; plain folders stay
 * top-level in place. */
export function groupByProject(
  groups: ReadonlyArray<WorkspaceGroup>,
): ReadonlyArray<ProjectGroup> {
  type Mutable = {
    key: string
    repositoryId: string | null
    label: string
    defaultBranch: string | null
    members: Array<WorkspaceGroup>
  }
  const byRepo = new Map<string, Mutable>()
  const ordered: Array<Mutable> = []

  for (const group of groups) {
    const repoId = group.workspace.repositoryId
    if (repoId === null) {
      ordered.push({
        key: group.workspace.id,
        repositoryId: null,
        label: group.workspace.name,
        defaultBranch: null,
        members: [group],
      })
      continue
    }
    const existing = byRepo.get(repoId)
    if (existing) {
      existing.members.push(group)
      continue
    }
    const created: Mutable = {
      key: repoId,
      repositoryId: repoId,
      label: group.workspace.repoLabel ?? group.workspace.name,
      defaultBranch: group.workspace.defaultBranch,
      members: [group],
    }
    byRepo.set(repoId, created)
    ordered.push(created)
  }

  for (const project of ordered) {
    if (project.repositoryId === null) continue
    project.members.sort((a, b) => {
      if (a.workspace.isWorktree !== b.workspace.isWorktree) return a.workspace.isWorktree ? 1 : -1
      return (a.workspace.branch ?? a.workspace.name).localeCompare(b.workspace.branch ?? b.workspace.name)
    })
  }
  return ordered
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
 * One chat pinned in the always-visible "Active" section: a chat with a live
 * (attached) or pending target. `context` is its location read as a path
 * (`repo > workspace > branch`), so the cross-project listing isn't ambiguous;
 * `pendingCount` drives the waiting badge and sorts those chats first.
 */
export interface ActiveChatEntry {
  readonly chat: Chat
  readonly sessions: ReadonlyArray<TargetSession>
  readonly pendingCount: number
  readonly context: string
}

/**
 * The chats to pin in the "Active" section: those with a live (attached,
 * non-exited) or pending target, pinned at the top so what's running stays
 * reachable however far the archive below scrolls. Pending chats sort first —
 * they're waiting on the user. A chat here is duplicated in the tree below; that
 * duplication is intentional (a shortcut, not a move).
 */
export function activeChatEntries(
  projects: ReadonlyArray<ProjectGroup>,
  workspaces: ReadonlyArray<Workspace>,
  chats: ReadonlyArray<Chat>,
  sessions: ReadonlyArray<TargetSession>,
  pendingSessionIds: ReadonlySet<string> | undefined,
): ReadonlyArray<ActiveChatEntry> {
  const byChat = new Map<ChatId, Array<TargetSession>>()
  for (const session of sessions) {
    const live = session.attached === true && session.state !== "exited"
    const pending = pendingSessionIds?.has(session.id) ?? false
    if (!live && !pending) continue
    const list = byChat.get(session.chatId) ?? []
    list.push(session)
    byChat.set(session.chatId, list)
  }
  const chatById = new Map(chats.map((chat) => [chat.id, chat] as const))
  const workspaceById = new Map(workspaces.map((workspace) => [workspace.id, workspace] as const))
  // Repository label per workspace, for repo-backed projects only — a plain
  // folder's project label is just the workspace name, so it adds nothing.
  const projectLabelByWorkspace = new Map<string, string>()
  for (const project of projects) {
    if (project.repositoryId === null) continue
    for (const member of project.members) projectLabelByWorkspace.set(member.workspace.id, project.label)
  }
  const entries: Array<ActiveChatEntry> = []
  for (const [chatId, chatSessions] of byChat) {
    const chat = chatById.get(chatId)
    if (chat === undefined) continue
    const pendingCount = chatSessions.filter((s) => pendingSessionIds?.has(s.id)).length
    // Where this chat lives, read as a path: repo > workspace > branch, dropping
    // any segment that just repeats the workspace name.
    const workspace = workspaceById.get(chat.workspaceId)
    const projectLabel = projectLabelByWorkspace.get(chat.workspaceId)
    const parts: Array<string> = []
    if (projectLabel && projectLabel !== workspace?.name) parts.push(projectLabel)
    if (workspace) {
      parts.push(workspace.name)
      if (workspace.branch && workspace.branch !== workspace.name) parts.push(workspace.branch)
    }
    entries.push({ chat, sessions: chatSessions, pendingCount, context: parts.join(" > ") })
  }
  entries.sort((a, b) => Number(b.pendingCount > 0) - Number(a.pendingCount > 0))
  return entries
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
): ReadonlyArray<TargetId> {
  const ordered: Array<TargetId> = []
  for (const { chats: chatGroup, sessionsByChat } of groupSidebarData(workspaces, chats, sessions)) {
    for (const chat of chatGroup) {
      for (const session of sessionsByChat.get(chat.id) ?? []) {
        if (pendingSessionIds.has(session.id)) ordered.push(session.id)
      }
    }
  }
  return ordered
}
