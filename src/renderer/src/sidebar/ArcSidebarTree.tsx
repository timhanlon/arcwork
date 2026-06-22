import { Fragment, type JSX, useMemo } from "react"
import { Collapsible } from "@base-ui/react/collapsible"
import { Button } from "@base-ui/react/button"
import { CaretDown, CaretRight } from "@phosphor-icons/react"
import type { Workspace } from "../../../shared/workspace.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import {
  groupByProject,
  groupSidebarData,
  liveActivityFor,
  sessionStatus,
  type LiveStateById,
} from "./grouping.js"
import { DISCLOSURE } from "./row-styles.js"
import { WorkspaceRow } from "./WorkspaceRow.js"
import { ChatRow } from "./ChatRow.js"
import { SessionRow } from "./SessionRow.js"

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
          {state.open ? (
            <CaretDown size={12} weight="bold" />
          ) : (
            <CaretRight size={12} weight="bold" />
          )}
        </button>
      )}
    />
  )
}

/** The project tier's header: a disclosure caret and the repo label (`owner/repo`
 * or basename). Collapsing it hides the whole project. Grouping cue, not
 * selectable; the repo's own branches live on the workspace rows beneath it. */
function ProjectHeader({ label }: { readonly label: string }): JSX.Element {
  return (
    <div className="mt-1 flex items-center gap-1 py-1 pr-2">
      <DisclosureTrigger label={`Toggle ${label}`} />
      <span className="min-w-0 truncate text-[12px] font-medium text-foreground">{label}</span>
    </div>
  )
}

export interface ArcSidebarSelection {
  readonly workspaceId?: string
  readonly chatId?: string
  readonly sessionId?: string
}

export interface LaunchableProvider {
  readonly kind: string
  readonly displayName: string
}

export interface ArcSidebarTreeProps {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
  readonly activeSessionId?: string
  /** session id → live activity, from the `arc:live-target-states` projection */
  readonly liveStateById?: LiveStateById
  /** session ids with a target-originated request still awaiting the user */
  readonly pendingSessionIds?: ReadonlySet<string>
  /** session id → ⌘-number slot (1–9) that jumps to it, for pending rows */
  readonly requestSlots?: ReadonlyMap<string, number>
  readonly selectedWorkspaceId?: string
  readonly selectedChatId?: string
  readonly onSelectChat: (workspaceId: string, chatId: string) => void
  readonly onSelectSession: (provider: string, chatId: string, sessionId: string) => void
  /** stop a session's live process (only attached sessions render the control) */
  readonly onStopSession?: (sessionId: string) => void
  /** re-attach a detached, resumable session (only those rows render the control) */
  readonly onResumeSession?: (sessionId: string) => void
  readonly onCreateChat: (workspaceId: string) => void
  readonly onRenameChat?: (chatId: string, title: string) => Promise<void>
  readonly onSelectionChange?: (selection: ArcSidebarSelection) => void
}

const EMPTY_LIVE_STATES: LiveStateById = new Map()

export function ArcSidebarTree(props: ArcSidebarTreeProps): JSX.Element {
  const liveStateById = props.liveStateById ?? EMPTY_LIVE_STATES
  const projects = useMemo(
    () => groupByProject(groupSidebarData(props.workspaces, props.chats, props.sessions)),
    [props.workspaces, props.chats, props.sessions],
  )

  const selectWorkspace = (workspaceId: string): void => {
    props.onSelectionChange?.({ workspaceId })
  }

  const selectChat = (workspaceId: string, chatId: string): void => {
    props.onSelectChat(workspaceId, chatId)
    props.onSelectionChange?.({ workspaceId, chatId })
  }

  const selectSession = (
    workspaceId: string,
    provider: string,
    chatId: string,
    sessionId: string,
  ): void => {
    props.onSelectSession(provider, chatId, sessionId)
    props.onSelectionChange?.({ workspaceId, chatId, sessionId })
  }

  return (
    <div
      className="min-h-[180px] min-w-0 flex-1 overflow-y-auto p-1"
      role="tree"
      aria-label="Arc workspaces"
    >
      {projects.map((project) => {
        const members = project.members.map(({ workspace, chats, sessionsByChat }) => (
          <Collapsible.Root key={workspace.id} defaultOpen className="min-w-0">
          <WorkspaceRow
            workspace={workspace}
            selected={props.selectedWorkspaceId === workspace.id && !props.selectedChatId}
            onSelect={() => selectWorkspace(workspace.id)}
            disclosure={<DisclosureTrigger label={`Toggle ${workspace.name}`} />}
          />

          <Collapsible.Panel className="ml-[18px]">
            <div role="group" aria-label={`${workspace.name} chats`}>
              <div className="mb-1 mt-2 flex items-center justify-between gap-2">
                <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-fg-faint">
                  Chats
                </span>
                <Button
                  className="min-h-5 w-auto flex-none cursor-pointer rounded-[var(--radius)] border border-border-strong bg-transparent px-[7px] py-px font-mono text-[10px] text-fg-dim hover:bg-elev hover:text-foreground focus-visible:bg-elev focus-visible:text-foreground focus-visible:outline-none"
                  title={`New chat in ${workspace.name}`}
                  onClick={() => props.onCreateChat(workspace.id)}
                >
                  + new
                </Button>
              </div>
              {chats.length === 0 ? (
                <div className="px-2 py-[5px] font-mono text-[11px] text-fg-faint">no chats yet</div>
              ) : (
                chats.map((chat) => {
                  const chatSessions = sessionsByChat.get(chat.id) ?? []
                  const pendingCount = chatSessions.filter((session) =>
                    props.pendingSessionIds?.has(session.id),
                  ).length
                  return (
                    <Collapsible.Root key={chat.id} defaultOpen className="min-w-0">
                      <ChatRow
                        chat={chat}
                        selected={props.selectedChatId === chat.id}
                        sessionCount={chatSessions.length}
                        pendingCount={pendingCount}
                        onSelect={() => selectChat(workspace.id, chat.id)}
                        onRename={props.onRenameChat ? (title) => props.onRenameChat!(chat.id, title) : undefined}
                        disclosure={<DisclosureTrigger label={`Toggle ${chat.title} sessions`} />}
                      />

                      <Collapsible.Panel className="ml-5">
                        <div role="group" aria-label={`${chat.title} sessions`}>
                          {chatSessions.map((session) => (
                            <SessionRow
                              key={session.id}
                              session={session}
                              status={sessionStatus(
                                liveActivityFor(session, liveStateById),
                                props.activeSessionId === session.id,
                              )}
                              pending={props.pendingSessionIds?.has(session.id) ?? false}
                              slot={props.requestSlots?.get(session.id)}
                              active={props.activeSessionId === session.id}
                              onSelect={() =>
                                selectSession(workspace.id, session.provider, chat.id, session.id)
                              }
                              onStop={
                                props.onStopSession
                                  ? () => props.onStopSession?.(session.id)
                                  : undefined
                              }
                              onResume={
                                props.onResumeSession
                                  ? () => props.onResumeSession?.(session.id)
                                  : undefined
                              }
                            />
                          ))}
                        </div>
                      </Collapsible.Panel>
                    </Collapsible.Root>
                  )
                })
              )}
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
        ))
        // Plain folders render in place with no header; a repository-backed
        // project gets a collapsible header with its checkouts/worktrees nested
        // under it.
        return project.repositoryId === null ? (
          <Fragment key={project.key}>{members}</Fragment>
        ) : (
          <Collapsible.Root key={project.key} defaultOpen className="min-w-0">
            <ProjectHeader label={project.label} />
            <Collapsible.Panel role="group" aria-label={project.label} className="ml-1">
              {members}
            </Collapsible.Panel>
          </Collapsible.Root>
        )
      })}
    </div>
  )
}
