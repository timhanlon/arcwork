import {
  createContext,
  Fragment,
  type JSX,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from "react"
import type { ChatId, TargetId, WorkspaceId } from "../../../shared/ids.js"
import { Collapsible } from "@base-ui/react/collapsible"
import { Button } from "@base-ui/react/button"
import { Exit } from "effect"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import { chatsAtom, createChatAtom, sessionsAtom, stopTargetAtom, successList, workspacesAtom } from "../atoms.js"
import { rpc } from "../rpc-client.js"
import { useShellActions } from "../shell/ShellActionsContext.js"
import { useShellState } from "../shell/ShellStateContext.js"
import { deriveShellViewModel } from "../shell/shellSelectors.js"
import {
  activeChatEntries,
  groupByProject,
  groupSidebarData,
  liveActivityFor,
  sessionStatus,
  type LiveStateById,
  type ProjectGroup,
  type WorkspaceGroup,
} from "./grouping.js"
import {
  CHAT_EXPANDER_BUTTON,
  CHAT_NEW_BUTTON,
  DISCLOSURE,
  ROW_BASE,
  ROW_GRID,
  TREE_LABEL,
} from "./row-styles.js"
import { WorkspaceRow } from "./WorkspaceRow.js"
import { ChatRow } from "./ChatRow.js"
import { SessionRow } from "./SessionRow.js"
import { useSidebarDisclosure, type SidebarDisclosureHandle } from "./sidebarDisclosure.js"
import { DisclosureSection } from "../ui/DisclosureSection.js"
import { Caret } from "../ui/Caret.js"
import { Indent } from "../ui/Indent.js"
import { useSessionActivityProjection } from "./useSessionActivityProjection.js"

/** How many chats a workspace shows before a "show all" expander — keeps a
 * profile with hundreds of chats from rendering the whole list. Chats arrive
 * newest-first, so the cap keeps the most recent. */
const CHAT_CAP = 15

// ---------------------------------------------------------------------------
// Shared tree controller
//
// Every node in the tree (project → workspace → chat → session) needs the same
// handful of things: the disclosure handle, the selection callbacks, and the
// live/pending/active session state. Threading those through four nesting levels
// as props would drown each node's own logic, so they ride a context the shell
// builds once and every node reads.
// ---------------------------------------------------------------------------

interface SidebarTreeController {
  readonly disclosure: SidebarDisclosureHandle
  readonly selectedWorkspaceId?: string
  readonly selectedChatId?: string
  readonly activeSessionId?: TargetId
  readonly liveStateById: LiveStateById
  readonly pendingSessionIds?: ReadonlySet<string>
  readonly requestSlots?: ReadonlyMap<string, number>
  /** The chat to keep revealed (selected, else owner of the active session). */
  readonly revealChatId?: string
  readonly selectWorkspace: (workspaceId: WorkspaceId) => void
  readonly selectChat: (workspaceId: WorkspaceId, chatId: ChatId) => void
  readonly selectSession: (
    workspaceId: WorkspaceId,
    provider: string,
    chatId: ChatId,
    sessionId: TargetId,
  ) => void
  readonly onStopSession?: (sessionId: TargetId) => void
  readonly onResumeSession?: (sessionId: TargetId) => void
  readonly onRenameChat?: (chatId: ChatId, title: string) => Promise<void>
  readonly onCreateChat: (workspaceId: WorkspaceId) => void
  /** workspace ids whose chat list is expanded past {@link CHAT_CAP} */
  readonly expandedChatLists: ReadonlySet<string>
  readonly toggleChatList: (workspaceId: WorkspaceId) => void
}

const TreeContext = createContext<SidebarTreeController | null>(null)

function useTree(): SidebarTreeController {
  const ctx = useContext(TreeContext)
  if (ctx === null) throw new Error("sidebar tree node rendered outside its provider")
  return ctx
}

// ---------------------------------------------------------------------------
// Disclosure carets
// ---------------------------------------------------------------------------

/**
 * Collapsible disclosure caret. Renders Phosphor's caret-down when the panel is
 * open and caret-right when collapsed, switching off Base UI's trigger state so
 * the glyph always tracks the panel.
 */
function DisclosureTrigger({ label }: { readonly label: string }): JSX.Element {
  return (
    <Collapsible.Trigger
      className={DISCLOSURE}
      aria-label={label}
      render={(props, state) => (
        <button type="button" {...props}>
          <Caret open={state.open} />
        </button>
      )}
    />
  )
}

/** A single repository's header inside the Projects section: a disclosure caret
 * and the repo label (`owner/repo` or basename), grouping its checkouts and
 * worktrees. A grouping cue, not selectable — the repo's branches live on the
 * workspace rows beneath it. */
function ProjectHeader({ label }: { readonly label: string }): JSX.Element {
  return (
    <Collapsible.Trigger
      className={`w-full ${ROW_GRID}`}
      aria-label={`Toggle ${label}`}
      render={(props, state) => (
        <button type="button" {...props}>
          <Caret open={state.open} />
          <span className={`${ROW_BASE} min-w-0 gap-2`}>
            <span className={TREE_LABEL}>{label}</span>
          </span>
        </button>
      )}
    />
  )
}

// ---------------------------------------------------------------------------
// Tree nodes (leaf → root)
// ---------------------------------------------------------------------------

/** A leaf session row, wired to the shared controller for its status, pending
 * pip, and stop/resume controls. */
function TreeSessionRow({
  workspaceId,
  chatId,
  session,
}: {
  readonly workspaceId: WorkspaceId
  readonly chatId: ChatId
  readonly session: TargetSession
}): JSX.Element {
  const tree = useTree()
  const active = tree.activeSessionId === session.id
  return (
    <SessionRow
      session={session}
      status={sessionStatus(liveActivityFor(session, tree.liveStateById), active)}
      pending={tree.pendingSessionIds?.has(session.id) ?? false}
      slot={tree.requestSlots?.get(session.id)}
      active={active}
      onSelect={() => tree.selectSession(workspaceId, session.provider, chatId, session.id)}
      onStop={tree.onStopSession ? () => tree.onStopSession?.(session.id) : undefined}
      onResume={tree.onResumeSession ? () => tree.onResumeSession?.(session.id) : undefined}
    />
  )
}

/** One chat in the tree: a collapsible chat row over its session list. The panel
 * auto-opens when the chat is selected or owns the active session. */
function ChatNode({
  workspaceId,
  chat,
  sessions,
}: {
  readonly workspaceId: WorkspaceId
  readonly chat: Chat
  readonly sessions: ReadonlyArray<TargetSession>
}): JSX.Element {
  const tree = useTree()
  const pendingCount = sessions.filter((session) => tree.pendingSessionIds?.has(session.id)).length
  const autoOpen =
    tree.selectedChatId === chat.id || sessions.some((session) => session.id === tree.activeSessionId)
  const open = tree.disclosure.isOpen("chat", chat.id, autoOpen)
  return (
    <Collapsible.Root
      open={open}
      onOpenChange={(next) => tree.disclosure.setOpen("chat", chat.id, next)}
      className="min-w-0"
    >
      <ChatRow
        chat={chat}
        selected={tree.selectedChatId === chat.id}
        expanded={open}
        sessionCount={sessions.length}
        pendingCount={pendingCount}
        onSelect={() => tree.selectChat(workspaceId, chat.id)}
        onRename={tree.onRenameChat ? (title) => tree.onRenameChat!(chat.id, title) : undefined}
        disclosure={<DisclosureTrigger label={`Toggle ${chat.title} sessions`} />}
      />
      <Collapsible.Panel>
        <Indent role="group" aria-label={`${chat.title} sessions`}>
          {sessions.map((session) => (
            <TreeSessionRow key={session.id} workspaceId={workspaceId} chatId={chat.id} session={session} />
          ))}
        </Indent>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** One workspace in the tree: the workspace row over a "Chats" section that
 * caps a long list behind a "show all" expander. */
function WorkspaceNode({ group }: { readonly group: WorkspaceGroup }): JSX.Element {
  const tree = useTree()
  const { workspace, chats, sessionsByChat } = group
  const workspaceOpen = tree.disclosure.isOpen("workspace", workspace.id, true)
  const chatsOpen = tree.disclosure.isOpen("chatSection", workspace.id, false)

  // Cap the list unless the user expanded it, or the chat being revealed lives
  // past the cap (don't hide a selected chat behind "show all").
  const revealIndex =
    tree.revealChatId === undefined ? -1 : chats.findIndex((chat) => chat.id === tree.revealChatId)
  const showAllChats = tree.expandedChatLists.has(workspace.id) || revealIndex >= CHAT_CAP
  const visibleChats = showAllChats ? chats : chats.slice(0, CHAT_CAP)

  return (
    <Collapsible.Root
      open={workspaceOpen}
      onOpenChange={(open) => tree.disclosure.setOpen("workspace", workspace.id, open)}
      className="min-w-0"
    >
      <WorkspaceRow
        workspace={workspace}
        selected={tree.selectedWorkspaceId === workspace.id && !tree.selectedChatId}
        expanded={workspaceOpen}
        onSelect={() => tree.selectWorkspace(workspace.id)}
        disclosure={<DisclosureTrigger label={`Toggle ${workspace.name}`} />}
      />
      <Collapsible.Panel>
        <Indent>
        <DisclosureSection
          title="Chats"
          count={chats.length}
          open={chatsOpen}
          onToggle={() => tree.disclosure.setOpen("chatSection", workspace.id, !chatsOpen)}
          actions={
            <Button
              className={CHAT_NEW_BUTTON}
              title={`New chat in ${workspace.name}`}
              onClick={() => {
                tree.disclosure.setOpen("chatSection", workspace.id, true)
                tree.onCreateChat(workspace.id)
              }}
            >
              + new
            </Button>
          }
        >
          <div role="group" aria-label={`${workspace.name} chats`}>
            {chats.length === 0 ? (
              <div className="px-2 py-1.5 font-mono text-[11px] text-fg-faint">no chats yet</div>
            ) : (
              visibleChats.map((chat) => (
                <ChatNode
                  key={chat.id}
                  workspaceId={workspace.id}
                  chat={chat}
                  sessions={sessionsByChat.get(chat.id) ?? []}
                />
              ))
            )}
            {chats.length > CHAT_CAP ? (
              <button
                type="button"
                onClick={() => tree.toggleChatList(workspace.id)}
                className={CHAT_EXPANDER_BUTTON}
              >
                {showAllChats ? "show fewer" : `show all ${chats.length}`}
              </button>
            ) : null}
          </div>
        </DisclosureSection>
        </Indent>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** One project in the tree. A plain folder (no repository) renders its single
 * workspace in place with no header; a repository-backed project gets a
 * collapsible repo header nesting its checkouts and worktrees. */
function ProjectNode({ project }: { readonly project: ProjectGroup }): JSX.Element {
  const tree = useTree()
  const members = (
    <>
      {project.members.map((member) => (
        <WorkspaceNode key={member.workspace.id} group={member} />
      ))}
    </>
  )
  if (project.repositoryId === null) return <Fragment>{members}</Fragment>
  return (
    <Collapsible.Root
      open={tree.disclosure.isOpen("project", project.key, false)}
      onOpenChange={(open) => tree.disclosure.setOpen("project", project.key, open)}
      className="min-w-0"
    >
      <ProjectHeader label={project.label} />
      <Collapsible.Panel>
        <Indent role="group" aria-label={project.label}>
          {members}
        </Indent>
      </Collapsible.Panel>
    </Collapsible.Root>
  )
}

/** The pinned "Active" section: chats with a live or pending target, kept above
 * the scroll region so what's running stays visible. Each chat's sessions render
 * always-expanded — this is a flat shortcut list, not a collapsible tree. */
function ActiveSection({
  entries,
}: {
  readonly entries: ReturnType<typeof activeChatEntries>
}): JSX.Element {
  const tree = useTree()
  const open = tree.disclosure.isOpen("section", "active", true)
  return (
    <DisclosureSection
      title="Active"
      count={entries.length}
      open={open}
      onToggle={() => tree.disclosure.setOpen("section", "active", !open)}
    >
      <div>
        {entries.map(({ chat, sessions, pendingCount, context }) => (
          <div key={`active-${chat.id}`} className="min-w-0">
            <ChatRow
              chat={chat}
              selected={tree.selectedChatId === chat.id}
              expanded
              subtitle={context}
              sessionCount={sessions.length}
              pendingCount={pendingCount}
              onSelect={() => tree.selectChat(chat.workspaceId, chat.id)}
              disclosure={
                <span className="inline-flex h-6 items-center justify-center">
                  <Caret open />
                </span>
              }
            />
            <Indent role="group" aria-label={`${chat.title} active sessions`}>
              {sessions.map((session) => (
                <TreeSessionRow
                  key={session.id}
                  workspaceId={chat.workspaceId}
                  chatId={chat.id}
                  session={session}
                />
              ))}
            </Indent>
          </div>
        ))}
      </div>
    </DisclosureSection>
  )
}

// ---------------------------------------------------------------------------
// Shell
// ---------------------------------------------------------------------------

export function ArcSidebarTree(): JSX.Element {
  // Self-sourcing: the server lists come straight off their atoms, selection off
  // the shell-state context, and every pick dispatches through the shell actions —
  // so App renders <ArcSidebarTree/> with no props and a story renders it under a
  // seeded registry + shell.
  const workspaces = successList(useAtomValue(workspacesAtom))
  const chats = successList(useAtomValue(chatsAtom))
  const sessions = successList(useAtomValue(sessionsAtom))

  const shellActions = useShellActions()
  const shellState = useShellState()
  const vm = useMemo(
    () => deriveShellViewModel(shellState, { workspaces, chats, sessions }),
    [shellState, workspaces, chats, sessions],
  )
  const { workspaceId: selectedWorkspaceId, chatId: selectedChatId, activeSessionId } = vm

  const { liveStateById, pendingSessionIds, requestSlots } = useSessionActivityProjection({
    workspaces,
    chats,
    sessions,
  })

  const runCreateChat = useAtomSet(createChatAtom, { mode: "promiseExit" })
  const runStopTarget = useAtomSet(stopTargetAtom)
  const createChat = useCallback(
    async (workspaceId: WorkspaceId): Promise<void> => {
      const exit = await runCreateChat({ payload: { workspaceId } })
      if (Exit.isSuccess(exit)) shellActions.selectChat(workspaceId, exit.value.id)
    },
    [runCreateChat, shellActions],
  )
  const renameChat = useCallback(async (chatId: ChatId, title: string): Promise<void> => {
    await rpc("UpdateChatTitle", { chatId, title })
  }, [])
  const stopSession = useCallback(
    (sessionId: TargetId): void => {
      shellActions.stopSession(sessionId)
      runStopTarget({ payload: { sessionId } })
    },
    [runStopTarget, shellActions],
  )

  const projects = useMemo(
    () => groupByProject(groupSidebarData(workspaces, chats, sessions)),
    [workspaces, chats, sessions],
  )
  const activeChats = useMemo(
    () => activeChatEntries(projects, workspaces, chats, sessions, pendingSessionIds),
    [projects, workspaces, chats, sessions, pendingSessionIds],
  )

  // Every disclosure in the tree (projects, workspaces, per-workspace Chats
  // sections, individual chats) persists its open/closed state to localStorage so
  // the sidebar reopens the way it was left. Untouched nodes fall back to their
  // per-node default (see each node): projects/Chats sections start collapsed,
  // workspaces start open, and a chat auto-opens when selected or active.
  const disclosure = useSidebarDisclosure()

  // Workspaces whose chat list is expanded past CHAT_CAP. Ephemeral — re-capping
  // on reload is the safe default for a huge list.
  const [expandedChatLists, setExpandedChatLists] = useState<ReadonlySet<string>>(() => new Set())
  const toggleChatList = useCallback((workspaceId: WorkspaceId): void => {
    setExpandedChatLists((prev) => {
      const next = new Set(prev)
      if (next.has(workspaceId)) next.delete(workspaceId)
      else next.add(workspaceId)
      return next
    })
  }, [])

  // chat id → its place in the tree, so selecting a chat can reveal the whole
  // ancestor chain (project → workspace → Chats section), not just the leaf.
  const chatLocation = useMemo(() => {
    const map = new Map<
      string,
      { readonly projectKey: string; readonly collapsibleProject: boolean; readonly workspaceId: WorkspaceId }
    >()
    for (const project of projects) {
      for (const { workspace, chats } of project.members) {
        for (const chat of chats) {
          map.set(chat.id, {
            projectKey: project.key,
            collapsibleProject: project.repositoryId !== null,
            workspaceId: workspace.id,
          })
        }
      }
    }
    return map
  }, [projects])

  // The chat to keep revealed: the selected one, else whichever owns the active
  // session.
  const activeChatId = useMemo(() => {
    if (activeSessionId === undefined) return undefined
    return sessions.find((session) => session.id === activeSessionId)?.chatId
  }, [activeSessionId, sessions])
  const revealChatId = selectedChatId ?? activeChatId

  // Reveal-on-selection: when the target chat changes, open its ancestors so the
  // row is actually visible — overriding a collapsed ancestor, since selection is
  // the stronger signal. Fires only on change (not every render), so the user can
  // freely collapse afterward; `setOpen` no-ops when already open. The chat's own
  // session list is left to its auto-open default, so navigating doesn't
  // permanently expand every chat you ever touched.
  const { setOpen } = disclosure
  useEffect(() => {
    if (revealChatId === undefined) return
    const location = chatLocation.get(revealChatId)
    if (location === undefined) return
    if (location.collapsibleProject) setOpen("project", location.projectKey, true)
    setOpen("workspace", location.workspaceId, true)
    setOpen("chatSection", location.workspaceId, true)
  }, [revealChatId, chatLocation, setOpen])

  // The shared controller every node reads. Selection/dispatch is bundled here so
  // a node only ever sees `selectChat`/`selectSession` and dispatches through the
  // shell, never touching atoms or the machine directly. A context value can't be
  // constructed inline, so it's memoized over its real inputs.
  const controller = useMemo<SidebarTreeController>(
    () => ({
      disclosure,
      selectedWorkspaceId,
      selectedChatId,
      activeSessionId,
      liveStateById,
      pendingSessionIds,
      requestSlots,
      revealChatId,
      selectWorkspace: (workspaceId) => shellActions.selectSidebar({ workspaceId }),
      selectChat: (workspaceId, chatId) => {
        shellActions.selectChat(workspaceId, chatId)
        shellActions.selectSidebar({ workspaceId, chatId })
      },
      selectSession: (workspaceId, _provider, chatId, sessionId) => {
        shellActions.focusSession(sessionId)
        shellActions.selectSidebar({ workspaceId, chatId, sessionId })
      },
      onStopSession: stopSession,
      onResumeSession: shellActions.resumeSession,
      onRenameChat: renameChat,
      onCreateChat: createChat,
      expandedChatLists,
      toggleChatList,
    }),
    [
      disclosure,
      selectedWorkspaceId,
      selectedChatId,
      activeSessionId,
      liveStateById,
      pendingSessionIds,
      requestSlots,
      revealChatId,
      shellActions,
      stopSession,
      renameChat,
      createChat,
      expandedChatLists,
      toggleChatList,
    ],
  )

  return (
    <TreeContext.Provider value={controller}>
      <div
        className="flex min-h-0 min-w-0 flex-1 flex-col"
        role="tree"
        aria-label="Arc workspaces"
      >
        {/* Active stays out of the scroll region entirely, so it's always
            visible; the project tree below scrolls under the sticky Projects
            header. */}
        {activeChats.length > 0 ? <ActiveSection entries={activeChats} /> : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          {projects.length > 0 ? (
            <DisclosureSection
              title="Projects"
              count={projects.length}
              open={disclosure.isOpen("section", "projects", true)}
              onToggle={() =>
                disclosure.setOpen("section", "projects", !disclosure.isOpen("section", "projects", true))
              }
              sticky
            >
              <div>
                {projects.map((project) => (
                  <ProjectNode key={project.key} project={project} />
                ))}
              </div>
            </DisclosureSection>
          ) : null}
        </div>
      </div>
    </TreeContext.Provider>
  )
}
