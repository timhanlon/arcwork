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
import { loadPersistedSelection, savePersistedSelection } from "./shellPersistence.js"
import { fileHrefToPath, resolveWorkspaceFile } from "./workspaceFilePath.js"
import { arcImgFileSrc, isImagePath } from "../../../shared/images.js"
import { DEV } from "../bridge.js"

export interface ArcShellActions {
  readonly selectChat: (workspaceId: WorkspaceId, chatId: ChatId) => void
  readonly selectSidebar: (selection: ShellTreeSelection) => void
  /** The one pane-opening verb — `open({kind:"work", workId}, "right")`,
   * `open({kind:"chat"}, "center")`, `open({kind:"git", path?}, "right")`, … —
   * replacing the old setCenterView/setRightView/openWorkInRightPane/
   * selectGitPath/closeRightWork. Illegal (target, pane) pairs are no-ops. */
  readonly open: (target: OpenTarget, pane: Pane) => void
  /** Open a file the assistant linked in a transcript (`[foo.ts](/abs/path/foo.ts)`,
   * optionally with a `:line`). Resolves the absolute path (or `file://` URL)
   * against the open workspaces: inside one → the read-only editor pane; outside
   * all of them → the OS opener. Returns `true` when the href was a file path it
   * took over (so the caller prevents the anchor's navigation), `false` for a
   * non-file href (http/mailto/relative) — left to navigate normally. */
  readonly openFilePath: (href: string) => boolean
  readonly launchTarget: (provider: string, chatId: ChatId) => void
  readonly bindTarget: (paneId: PaneId, sessionId: TargetId) => void
  readonly focusSession: (sessionId: TargetId) => void
  /** Make a target current (composer addressee) from its session ref directly —
   * for the rpc launch/resume path, which returns the session before it lands in
   * the live list, so a `focusSession(id)` lookup would race and miss. */
  readonly focusTarget: (session: ShellSessionRef) => void
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
      runtime: session.runtime,
    },
    workspaceId: workspaceIdForChat(chats, session.chatId),
  }
}

export function useArcShell({
  workspaces,
  chats,
  sessions,
}: {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
}): ArcShell {
  const actor = useMemo(
    () => createActor(arcShellMachine, { input: loadPersistedSelection() }).start(),
    [],
  )

  useEffect(() => {
    return () => {
      if (DEV) return
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

  // Persist the selection slice whenever it changes; `selection` keeps the same
  // reference across layout/pane-only updates, so this only writes on real picks.
  useEffect(() => {
    savePersistedSelection(state.selection)
  }, [state.selection])

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
      openFilePath: (href) => {
        const target = fileHrefToPath(href)
        // Not an absolute file path (an http/mailto/relative link): leave it to the
        // anchor's own navigation, which the main process routes externally.
        if (!target) return false
        // An image opens in the in-app viewer pane regardless of workspace — its
        // bytes are served by the `arc-img` protocol by absolute path, so a `/tmp`
        // scratchpad image works the same as one inside a repo.
        if (isImagePath(target.path)) {
          actor.send({
            type: "SURFACE_OPENED",
            target: { kind: "image", src: arcImgFileSrc(target.path), title: target.path.split("/").pop() },
            pane: "right",
          })
          return true
        }
        const resolved = resolveWorkspaceFile(workspaces, target.path)
        if (resolved) {
          actor.send({
            type: "SURFACE_OPENED",
            target: { kind: "file", ...resolved, line: target.line },
            pane: "right",
          })
        } else {
          // Outside every open workspace, so the in-app editor can't resolve it —
          // hand the bare path to the OS opener. `window.arc` is attached long
          // before any click; optional-chain guards Storybook, where it's absent.
          window.arc?.openPath(target.path)
        }
        // Either way it was a file path we took responsibility for — tell the
        // caller to prevent the anchor's default navigation.
        return true
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
      focusTarget: (session) => {
        actor.send({
          type: "SESSION_FOCUSED",
          paneId: newArcId("pane"),
          session,
          workspaceId: workspaceIdForChat(chats, session.chatId),
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
    [actor, workspaces, chats, sessions],
  )

  return { state, actions }
}
