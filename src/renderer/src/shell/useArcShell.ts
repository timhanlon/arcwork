import { useEffect, useMemo, useSyncExternalStore } from "react"
import { createActor } from "xstate"
import type { Chat } from "../../../shared/chat.js"
import { type ChatId, newArcId, type PaneId, type TargetId, type WorkspaceId } from "../../../shared/ids.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { Workspace } from "../../../shared/workspace.js"
import {
  arcShellMachine,
  type ArcShellActor,
  type ArcShellContext,
  type OpenTarget,
  type Pane,
  type ShellSessionRef,
  type ShellTreeSelection,
} from "./arcShellMachine.js"
type ViteImportMeta = ImportMeta & { readonly env?: { readonly DEV?: boolean } }

const isDevelopment = ((import.meta as ViteImportMeta).env?.DEV ?? false) === true

export interface ArcShellActions {
  readonly selectChat: (workspaceId: WorkspaceId, chatId: ChatId) => void
  readonly selectSidebar: (selection: ShellTreeSelection) => void
  /** The one pane-opening verb — `open({kind:"work", workId}, "right")`,
   * `open({kind:"chat"}, "center")`, `open({kind:"git", path?}, "right")`, … —
   * replacing the old setCenterView/setRightView/openWorkInRightPane/
   * selectGitPath/closeRightWork. Illegal (target, pane) pairs are no-ops. */
  readonly open: (target: OpenTarget, pane: Pane) => void
  readonly launchTarget: (provider: string, chatId: ChatId) => void
  readonly bindTarget: (paneId: PaneId, sessionId: TargetId) => void
  readonly focusSession: (sessionId: TargetId) => void
  readonly adoptSession: (session: ShellSessionRef) => void
  readonly resumeDetached: () => void
  /** Re-attach a specific detached/resumable session (e.g. its sidebar row). */
  readonly resumeSession: (sessionId: TargetId) => void
  readonly ptyExited: (sessionId: TargetId) => void
  readonly stopSession: (sessionId: TargetId) => void
  readonly focusComposer: () => void
  readonly jumpChatToBottom: () => void
  /** Surface the work navigator (center) and open the new-work form. */
  readonly createWork: () => void
  readonly toggleLeftPanel: () => void
  readonly toggleRightPanel: () => void
  readonly setLeftCollapsed: (collapsed: boolean) => void
  readonly setRightCollapsed: (collapsed: boolean) => void
  readonly actor: ArcShellActor
}

export interface ArcShell {
  readonly state: ArcShellContext
  readonly actions: ArcShellActions
}

const workspaceIdForChat = (
  chats: ReadonlyArray<Chat>,
  chatId: ChatId,
): WorkspaceId | undefined => chats.find((chat) => chat.id === chatId)?.workspaceId

const workspaceForSession = (
  sessions: ReadonlyArray<TargetSession>,
  chats: ReadonlyArray<Chat>,
  sessionId: TargetId,
): { readonly session: ShellSessionRef; readonly workspaceId?: WorkspaceId } | undefined => {
  const session = sessions.find((candidate) => candidate.id === sessionId)
  if (!session) return undefined
  return {
    session: {
      id: session.id,
      provider: session.provider,
      chatId: session.chatId,
      attached: session.attached ?? false,
    },
    workspaceId: workspaceIdForChat(chats, session.chatId),
  }
}

export function useArcShell({
  chats,
  sessions,
}: {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
}): ArcShell {
  const actor = useMemo(() => createActor(arcShellMachine).start(), [])

  useEffect(() => {
    return () => {
      if (isDevelopment) return
      actor.stop()
    }
  }, [actor])

  const snapshot = useSyncExternalStore(
    (onStoreChange) => {
      const subscription = actor.subscribe(onStoreChange)
      return () => subscription.unsubscribe()
    },
    () => actor.getSnapshot(),
    () => actor.getSnapshot(),
  )
  const state = snapshot.context

  const actions = useMemo<ArcShellActions>(
    () => ({
      actor,
      selectChat: (workspaceId, chatId) => {
        actor.send({ type: "CHAT_SELECTED", workspaceId, chatId })
      },
      selectSidebar: (selection) => {
        actor.send({ type: "SIDEBAR_SELECTION_CHANGED", selection })
      },
      open: (target, pane) => {
        actor.send({ type: "SURFACE_OPENED", target, pane })
      },
      launchTarget: (provider, chatId) => {
        actor.send({
          type: "TARGET_LAUNCH_REQUESTED",
          paneId: newArcId("pane"),
          provider,
          chatId,
          workspaceId: workspaceIdForChat(chats, chatId),
        })
      },
      bindTarget: (paneId, sessionId) => {
        actor.send({ type: "TARGET_BOUND", paneId, sessionId })
      },
      focusSession: (sessionId) => {
        const resolved = workspaceForSession(sessions, chats, sessionId)
        if (!resolved) return
        actor.send({
          type: "SESSION_FOCUSED",
          paneId: newArcId("pane"),
          session: resolved.session,
          workspaceId: resolved.workspaceId,
        })
      },
      adoptSession: (session) => {
        actor.send({ type: "TARGET_ADOPTED", paneId: newArcId("pane"), session })
      },
      resumeSession: (sessionId) => {
        const resolved = workspaceForSession(sessions, chats, sessionId)
        if (!resolved) return
        actor.send({
          type: "DETACHED_RESUME_REQUESTED",
          paneId: newArcId("pane"),
          session: resolved.session,
          workspaceId: resolved.workspaceId,
        })
      },
      resumeDetached: () => {
        const detachedSessionId = actor.getSnapshot().context.detachedSessionId
        if (!detachedSessionId) return
        actions.resumeSession(detachedSessionId)
      },
      ptyExited: (sessionId) => {
        actor.send({ type: "PTY_EXITED", sessionId })
      },
      stopSession: (sessionId) => {
        actor.send({ type: "SESSION_STOP_REQUESTED", sessionId })
      },
      focusComposer: () => {
        actor.send({ type: "COMPOSER_FOCUS_REQUESTED" })
      },
      jumpChatToBottom: () => {
        actor.send({ type: "CHAT_JUMP_TO_BOTTOM_REQUESTED" })
      },
      createWork: () => {
        actor.send({ type: "WORK_CREATE_REQUESTED" })
      },
      toggleLeftPanel: () => {
        actor.send({ type: "LEFT_PANEL_TOGGLED" })
      },
      toggleRightPanel: () => {
        actor.send({ type: "RIGHT_PANEL_TOGGLED" })
      },
      setLeftCollapsed: (collapsed) => {
        actor.send({ type: "LEFT_PANEL_COLLAPSED_CHANGED", collapsed })
      },
      setRightCollapsed: (collapsed) => {
        actor.send({ type: "RIGHT_PANEL_COLLAPSED_CHANGED", collapsed })
      },
    }),
    [actor, chats, sessions],
  )

  return { state, actions }
}
