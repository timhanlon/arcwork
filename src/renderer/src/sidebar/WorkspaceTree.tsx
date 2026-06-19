import { type JSX, useMemo, useState } from "react"
import { Collapsible } from "@base-ui/react/collapsible"
import { Button } from "@base-ui/react/button"
import {
  ArrowsInLineVertical,
  ArrowsOutLineVertical,
  CaretDown,
  CaretRight,
  NotePencil,
} from "@phosphor-icons/react"
import type { Workspace } from "../../../shared/workspace.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import { groupSidebarData, liveActivityFor, sessionStatus, type LiveStateById } from "./grouping.js"
import { DISCLOSURE } from "./row-styles.js"
import { WorkspaceRow } from "./WorkspaceRow.js"
import { ChatRow } from "./ChatRow.js"
import { SessionRow } from "./SessionRow.js"
import { WorkRow, type ChatWorkRelation } from "./WorkRow.js"
import type { Work } from "../../../shared/work.js"

/**
 * Storybook prototype of the workspace sidebar tree. Extends the production
 * {@link ArcSidebarTree} with chat-scoped work rows, a collapse-all-chats control
 * per workspace, and an iconographic new-chat affordance. Not wired into the app
 * yet — iterate here, then promote deltas back into ArcSidebarTree.
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

export interface ChatScopedWork {
  readonly work: Work
  readonly relation: ChatWorkRelation
}

export interface WorkspaceTreeSelection {
  readonly workspaceId?: string
  readonly chatId?: string
  readonly sessionId?: string
  readonly workId?: string
}

export interface WorkspaceTreeProps {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
  /** chat id → work authored in or mentioned by that chat */
  readonly workByChat?: ReadonlyMap<string, ReadonlyArray<ChatScopedWork>>
  readonly activeSessionId?: string
  readonly liveStateById?: LiveStateById
  readonly pendingSessionIds?: ReadonlySet<string>
  readonly requestSlots?: ReadonlyMap<string, number>
  readonly selectedWorkspaceId?: string
  readonly selectedChatId?: string
  readonly selectedWorkId?: string
  readonly onSelectChat: (workspaceId: string, chatId: string) => void
  readonly onSelectSession: (provider: string, chatId: string, sessionId: string) => void
  readonly onSelectWork?: (workspaceId: string, chatId: string, workId: string) => void
  readonly onStopSession?: (sessionId: string) => void
  readonly onCreateChat: (workspaceId: string) => void
  readonly onRenameChat?: (chatId: string, title: string) => Promise<void>
  readonly onSelectionChange?: (selection: WorkspaceTreeSelection) => void
}

const EMPTY_LIVE_STATES: LiveStateById = new Map()
const EMPTY_WORK_BY_CHAT: ReadonlyMap<string, ReadonlyArray<ChatScopedWork>> = new Map()

const HEADER_ACTION =
  "inline-flex size-5 cursor-pointer items-center justify-center rounded-[4px] border-0 bg-transparent p-0 text-fg-faint hover:bg-elev hover:text-foreground focus-visible:bg-elev focus-visible:text-foreground focus-visible:outline-none disabled:cursor-default disabled:opacity-[0.35]"

const NEW_CHAT =
  "inline-flex size-5 cursor-pointer items-center justify-center rounded-[4px] border border-border-strong bg-transparent p-0 text-fg-dim hover:bg-elev hover:text-foreground focus-visible:bg-elev focus-visible:text-foreground focus-visible:outline-none"

export function WorkspaceTree(props: WorkspaceTreeProps): JSX.Element {
  const liveStateById = props.liveStateById ?? EMPTY_LIVE_STATES
  const workByChat = props.workByChat ?? EMPTY_WORK_BY_CHAT
  const groups = useMemo(
    () => groupSidebarData(props.workspaces, props.chats, props.sessions),
    [props.workspaces, props.chats, props.sessions],
  )
  const [collapsedChats, setCollapsedChats] = useState<ReadonlySet<string>>(() => new Set())

  const isChatOpen = (chatId: string): boolean => !collapsedChats.has(chatId)

  const setChatOpen = (chatId: string, open: boolean): void => {
    setCollapsedChats((prev) => {
      const next = new Set(prev)
      if (open) next.delete(chatId)
      else next.add(chatId)
      return next
    })
  }

  const setAllChatsOpen = (chatIds: ReadonlyArray<string>, open: boolean): void => {
    setCollapsedChats((prev) => {
      const next = new Set(prev)
      for (const chatId of chatIds) {
        if (open) next.delete(chatId)
        else next.add(chatId)
      }
      return next
    })
  }

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

  const selectWork = (workspaceId: string, chatId: string, workId: string): void => {
    props.onSelectWork?.(workspaceId, chatId, workId)
    props.onSelectionChange?.({ workspaceId, chatId, workId })
  }

  return (
    <div
      className="min-h-[180px] min-w-0 flex-1 overflow-y-auto p-1"
      role="tree"
      aria-label="Arc workspaces"
    >
      {groups.map(({ workspace, chats, sessionsByChat }) => {
        const chatIds = chats.map((c) => c.id)
        const anyChatOpen = chatIds.some(isChatOpen)
        const allChatsCollapsed = chatIds.length > 0 && !anyChatOpen

        return (
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
                  <div className="flex items-center gap-1">
                    {chatIds.length > 0 && (
                      <Button
                        className={HEADER_ACTION}
                        title={allChatsCollapsed ? `Expand all chats in ${workspace.name}` : `Collapse all chats in ${workspace.name}`}
                        aria-label={allChatsCollapsed ? `Expand all chats in ${workspace.name}` : `Collapse all chats in ${workspace.name}`}
                        onClick={() => setAllChatsOpen(chatIds, allChatsCollapsed)}
                      >
                        {allChatsCollapsed ? (
                          <ArrowsOutLineVertical size={12} weight="bold" />
                        ) : (
                          <ArrowsInLineVertical size={12} weight="bold" />
                        )}
                      </Button>
                    )}
                    <Button
                      className={NEW_CHAT}
                      title={`New chat in ${workspace.name}`}
                      aria-label={`New chat in ${workspace.name}`}
                      onClick={() => props.onCreateChat(workspace.id)}
                    >
                      <NotePencil size={13} weight="bold" />
                    </Button>
                  </div>
                </div>
                {chats.length === 0 ? (
                  <div className="px-2 py-[5px] font-mono text-[11px] text-fg-faint">no chats yet</div>
                ) : (
                  chats.map((chat) => {
                    const chatSessions = sessionsByChat.get(chat.id) ?? []
                    const chatWork = workByChat.get(chat.id) ?? []
                    const pendingCount = chatSessions.filter((session) =>
                      props.pendingSessionIds?.has(session.id),
                    ).length
                    return (
                      <Collapsible.Root
                        key={chat.id}
                        open={isChatOpen(chat.id)}
                        onOpenChange={(open) => setChatOpen(chat.id, open)}
                        className="min-w-0"
                      >
                        <ChatRow
                          chat={chat}
                          selected={props.selectedChatId === chat.id}
                          sessionCount={chatSessions.length}
                          pendingCount={pendingCount}
                          onSelect={() => selectChat(workspace.id, chat.id)}
                          onRename={
                            props.onRenameChat ? (title) => props.onRenameChat!(chat.id, title) : undefined
                          }
                          disclosure={<DisclosureTrigger label={`Toggle ${chat.title}`} />}
                        />

                        <Collapsible.Panel className="ml-5">
                          <div role="group" aria-label={`${chat.title} contents`}>
                            {chatWork.map(({ work, relation }) => (
                              <WorkRow
                                key={work.id}
                                work={work}
                                relation={relation}
                                active={props.selectedWorkId === work.id}
                                onSelect={() => selectWork(workspace.id, chat.id, work.id)}
                              />
                            ))}
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
        )
      })}
    </div>
  )
}
