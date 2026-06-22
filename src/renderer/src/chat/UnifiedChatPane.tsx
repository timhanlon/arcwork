import { ArrowDown } from "@phosphor-icons/react"
import type { ChatId, TargetId } from "../../../shared/ids.js"
import { forwardRef, type JSX, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react"
import { useStickToBottom } from "use-stick-to-bottom"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { Workspace } from "../../../shared/workspace.js"
import type { LaunchableProvider } from "../sidebar/ArcSidebarTree.js"
import { useChatActivity } from "./useChatActivity.js"
import { useChatMessages } from "./useChatMessages.js"
import { useStreamingMessages } from "./useStreamingMessages.js"
import { useChatWork } from "./useChatWork.js"
import { ChatWork } from "./ChatWork.js"
import { ChatComposer, type ComposerHandle } from "./composer/ChatComposer.js"
import { ComposerTargetIndicators, formatAddressee } from "./composer/ComposerTargetIndicators.js"
import { useReferenceTargets } from "./composer/useReferenceTargets.js"
import { Button } from "../ui/Button.js"
import { KbdShortcut } from "../ui/Kbd.js"
import { comboFor } from "../shell/keybindings.js"
import { Message } from "./Message.js"
import { StreamingMessage } from "./StreamingMessage.js"
import { type TranscriptFilter, TranscriptFilterMenu, showsMessage } from "./TranscriptFilterMenu.js"
import { rpc } from "../rpc-client.js"
import { liveActivityFor, type LiveStateById } from "../sidebar/grouping.js"

export interface UnifiedChatPaneProps {
  readonly chat?: Chat
  readonly workspace?: Workspace
  readonly sessions: ReadonlyArray<TargetSession>
  /** session id → live activity, from the `arc:live-target-states` projection */
  readonly liveStateById?: LiveStateById
  readonly activeSessionId?: TargetId
  readonly sessionCount: number
  readonly providers: ReadonlyArray<LaunchableProvider>
  readonly onLaunch: (provider: string, chatId: ChatId) => void
  /** focus the live target session waiting on a pending question */
  readonly onFocusSession: (sessionId: TargetId) => void
  readonly onRenameChat: (chatId: ChatId, title: string) => Promise<void>
}

const addressableTarget = (
  chatId: ChatId,
  sessions: ReadonlyArray<TargetSession>,
  activeSessionId?: TargetId,
): TargetSession | undefined => {
  const inChat = sessions.filter((session) => session.chatId === chatId)
  const active =
    activeSessionId !== undefined
      ? inChat.find((session) => session.id === activeSessionId && session.attached)
      : undefined
  if (active) return active
  return inChat.find((session) => session.attached)
}

const CHAT_PANE = "flex h-full min-h-0 min-w-0 flex-col border-r border-border bg-background"

const EMPTY_LIVE_STATES: LiveStateById = new Map()

/**
 * Imperative handle App drives from the shell's emitted signals: ⌘L/launch →
 * `focusComposer`, ⌘↓/End → `scrollToBottom`. App holds the ref (not the pane
 * itself) because the pane unmounts on the work view — a request can ride the
 * same transition that remounts it, so App defers the call to the next frame.
 */
export interface ChatPaneHandle {
  readonly focusComposer: () => void
  readonly scrollToBottom: () => void
}

export const UnifiedChatPane = forwardRef<ChatPaneHandle, UnifiedChatPaneProps>(
  function UnifiedChatPane(props, ref): JSX.Element {
  const { chat, workspace, sessions, activeSessionId, sessionCount, providers, onLaunch, onFocusSession } =
    props
  const liveStateById = props.liveStateById ?? EMPTY_LIVE_STATES
  const messages = useChatMessages(chat?.id)
  const streams = useStreamingMessages(chat?.id, messages)
  const events = useChatActivity(chat?.id)
  // Work refreshes itself off the arc:work push (+ chat-activity fallback) inside
  // useChatWork; no caller-synthesized refresh token needed.
  const { work } = useChatWork(chat?.id)
  // How much non-prose activity (tool calls, questions) to interleave with the
  // prose turns. View-only, chat-local — throwaway `useState`, no persistence.
  const [filter, setFilter] = useState<TranscriptFilter>("all")
  const [draft, setDraft] = useState("")
  // The session the user pinned by `@`-mentioning it in the composer, overriding
  // the auto-picked addressee. Reset when the chat changes (it's chat-scoped).
  const [targetOverride, setTargetOverride] = useState<string | undefined>(undefined)
  const [composerError, setComposerError] = useState<string | undefined>(undefined)
  const [sending, setSending] = useState(false)
  const [titleEditing, setTitleEditing] = useState(false)
  const [titleDraft, setTitleDraft] = useState(chat?.title ?? "")
  const [titleError, setTitleError] = useState<string | undefined>(undefined)
  const [titleSaving, setTitleSaving] = useState(false)
  const titleInputRef = useRef<HTMLInputElement>(null)

  // Pin the transcript to the bottom as messages stream in, the same way the
  // streaming card does (use-stick-to-bottom): the lock follows new content but
  // releases when the reader scrolls up to read back. `scrollRef` goes on the
  // scroll container; `contentRef` on the inner wrapper the library measures.
  // `resize: "instant"` (not "smooth"): a smooth resize holds a ~350ms spring tail
  // open after every content height change, and the library drops a scroll-up
  // escape that lands while a resize is in flight — so reading back near a tall
  // code block (which keeps resizing as Shiki highlights) snapped the view back
  // to the bottom. Instant resize closes that race window.
  const { scrollRef, contentRef, scrollToBottom, isAtBottom } = useStickToBottom({
    initial: "instant",
    resize: "instant",
  })

  // Switching chats should land on the latest message immediately, regardless
  // of where the previous chat was scrolled (which would otherwise leave the
  // lock escaped).
  useEffect(() => {
    void scrollToBottom({ animation: "instant" })
  }, [chat?.id, scrollToBottom])

  // The shell's imperative signals land here (driven by App via this handle):
  // ⌘L/launch focuses the composer; ⌘↓/End scrolls the transcript to the latest
  // message (`smooth`, so the jump reads as motion).
  const composerHandleRef = useRef<ComposerHandle>(null)
  useImperativeHandle(
    ref,
    () => ({
      focusComposer: () => composerHandleRef.current?.focus(),
      scrollToBottom: () => void scrollToBottom({ animation: "smooth" }),
    }),
    [scrollToBottom],
  )

  useEffect(() => {
    setTargetOverride(undefined)
  }, [chat?.id])

  useEffect(() => {
    if (!titleEditing) setTitleDraft(chat?.title ?? "")
  }, [chat?.title, titleEditing])

  useEffect(() => {
    if (titleEditing) titleInputRef.current?.focus()
  }, [titleEditing])

  const attachedInChat = chat ? sessions.filter((session) => session.chatId === chat.id && session.attached) : []
  const sessionsInChat = chat ? sessions.filter((session) => session.chatId === chat.id) : []
  // A composer `@`-mention pins a specific session; fall back to the auto-picked
  // addressee when nothing is pinned (or the pinned one has left the chat).
  const overrideSession = targetOverride
    ? sessionsInChat.find((session) => session.id === targetOverride)
    : undefined
  const addressee =
    overrideSession ?? (chat ? addressableTarget(chat.id, sessions, activeSessionId) : undefined)

  // Targets the composer's `@` picker can reference: this chat's work + sessions
  // (in memory) and the workspace's files (lazily fetched on first mention).
  const { candidates, ensureFilesLoaded, filesTruncated } = useReferenceTargets({
    work,
    sessions: sessionsInChat,
    workspaceId: workspace?.id,
  })

  const targetLabelFor = (targetSessionId?: TargetId): string | undefined => {
    if (!targetSessionId) return undefined
    const session = sessionsInChat.find((s) => s.id === targetSessionId)
    return session ? formatAddressee(session, sessionsInChat) : undefined
  }

  const sendPrompt = useCallback(async (): Promise<void> => {
    if (!chat) return
    const text = draft
    if (!text.trim()) return

    if (!addressee) {
      setComposerError(
        attachedInChat.length === 0
          ? "No running target session — launch or resume a target before sending"
          : "No attached target session is available to receive this prompt",
      )
      return
    }

    setSending(true)
    setComposerError(undefined)
    try {
      await rpc("SendChatPrompt", {
        chatId: chat.id,
        targetSessionId: addressee.id,
        text,
      })
      setDraft("")
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error)
      setComposerError(message)
    } finally {
      setSending(false)
    }
  }, [addressee, attachedInChat.length, chat, draft])

  const beginTitleEdit = (): void => {
    if (!chat) return
    setTitleDraft(chat.title)
    setTitleError(undefined)
    setTitleEditing(true)
  }

  const cancelTitleEdit = (): void => {
    setTitleDraft(chat?.title ?? "")
    setTitleError(undefined)
    setTitleEditing(false)
  }

  const commitTitleEdit = async (): Promise<void> => {
    if (!chat || titleSaving) return
    const nextTitle = titleDraft.trim()
    if (nextTitle.length === 0) {
      setTitleError("Title cannot be empty")
      return
    }
    if (nextTitle === chat.title) {
      setTitleError(undefined)
      setTitleEditing(false)
      return
    }
    setTitleSaving(true)
    setTitleError(undefined)
    try {
      await props.onRenameChat(chat.id, nextTitle)
      setTitleEditing(false)
    } catch (error: unknown) {
      setTitleError(error instanceof Error ? error.message : String(error))
    } finally {
      setTitleSaving(false)
    }
  }

  if (!chat) {
    return (
      <section className={CHAT_PANE}>
        <div className="m-auto font-mono text-[12px] text-fg-faint">select a chat</div>
      </section>
    )
  }

  const showLaunchEmpty = sessionCount === 0 && messages.length === 0
  // A chat can hold at most one session per provider, so only offer to launch
  // the providers not already present in this chat.
  const providersInChat = new Set(sessionsInChat.map((session) => session.provider))
  const launchableProviders = providers.filter((provider) => !providersInChat.has(provider.kind))
  // Tool calls and questions are the payload-bearing rows; everything else is a
  // plain prose turn. Only surface the filter once there's activity to filter.
  const activityCount = messages.filter((message) => message.payload !== undefined).length
  const visibleMessages =
    filter === "all" ? messages : messages.filter((message) => showsMessage(message, filter))

  return (
    <section className={CHAT_PANE}>
      <header className="divide-y divide-border border-b border-border">
        <div className="flex flex-col min-w-0 w-full items-start gap-0.5 p-3">
          {workspace && (
            <div className="font-mono text-[10px] text-fg-dim">{workspace.name}</div>
          )}
          {titleEditing ? (
            <div className="grid min-w-0 flex-1 gap-1">
              <input
                ref={titleInputRef}
                className="min-w-0 bg-background font-sans text-[15px] font-medium leading-[1.3] text-foreground outline-none focus:border-accent"
                value={titleDraft}
                disabled={titleSaving}
                aria-label="Chat title"
                onChange={(event) => setTitleDraft(event.currentTarget.value)}
                onBlur={() => void commitTitleEdit()}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    void commitTitleEdit()
                  } else if (event.key === "Escape") {
                    event.preventDefault()
                    cancelTitleEdit()
                  }
                }}
              />
              {titleError && <span className="font-mono text-[10px] text-request">{titleError}</span>}
            </div>
          ) : (
            <h1
              className="min-w-0 flex-1 cursor-text overflow-hidden text-ellipsis whitespace-nowrap font-sans text-[15px] font-medium leading-[1.3]"
              title="Double-click to rename"
              onDoubleClick={beginTitleEdit}
            >
              {chat.title}
            </h1>
          )}
        </div>
        {work.length > 0 && (
          <div className="w-full max-h-40 overflow-y-auto p-3">
            <ChatWork work={work} />
          </div>
        )}
        <div className="p-3">
          {(activityCount > 0 || (!showLaunchEmpty && launchableProviders.length > 0)) && (
            <div className="flex w-full flex-wrap items-center gap-1 font-mono text-[10px]">
              {/* Choose how much non-prose activity to interleave. Lives in the
                  header on the left so it's a stable, always-in-place control
                  rather than scrolling with the log; only meaningful once there's
                  activity to filter. */}
              {activityCount > 0 && <TranscriptFilterMenu value={filter} onChange={setFilter} />}
              {/* Launch another target into this chat, right-aligned (`ml-auto`)
                  regardless of whether the filter is present. The empty state has
                  its own prominent buttons, so only surface this once past it —
                  this is the "add a target" affordance the empty state can't be.
                  Providers already in the chat are dropped: at most one session
                  per provider. */}
              {!showLaunchEmpty && launchableProviders.length > 0 && (
                <div className="ml-auto flex flex-wrap items-center gap-1">
                  {launchableProviders.map((provider) => (
                    <Button
                      key={provider.kind}
                      variant="ghost"
                      size="sm"
                      aria-label={`launch ${provider.kind}`}
                      onClick={() => onLaunch(provider.kind, chat.id)}
                    >
                      + {provider.kind}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </header>

      <div className="relative min-h-0 flex-1">
        <div ref={scrollRef} className="h-full overflow-y-auto p-4">
          <div ref={contentRef}>
          {showLaunchEmpty ? (
            <div className="grid max-w-[360px] justify-items-start gap-3">
              <p className="text-fg-faint">no sessions in this chat yet</p>
              {providers.length > 0 ? (
                <div className="flex flex-wrap gap-1.5">
                  {providers.map((provider) => (
                    <Button key={provider.kind} onClick={() => onLaunch(provider.kind, chat.id)}>
                      launch {provider.kind}
                    </Button>
                  ))}
                </div>
              ) : (
                <p className="text-fg-faint">no interactive providers available</p>
              )}
            </div>
          ) : (
            <>
              <div className="min-h-[120px]" aria-label="Chat messages">
                {messages.length === 0 ? (
                  <p className="m-0 font-mono text-[12px] text-fg-faint">
                    no messages yet — send a prompt from the composer below
                  </p>
                ) : (
                  <ol className="grid gap-3">
                    {visibleMessages.map((message) => (
                      <Message
                        key={message.id}
                        message={message}
                        target={targetLabelFor(message.targetSessionId)}
                        onFocusSession={onFocusSession}
                      />
                    ))}
                  </ol>
                )}
              </div>
            </>
          )}
          </div>
        </div>
        {!isAtBottom && (
          <div className="pointer-events-none absolute inset-x-0 bottom-3 z-10 flex justify-end px-3">
            <Button
              variant="ghost"
              size="sm"
              className="pointer-events-auto inline-flex items-center gap-1.5 border-border-strong bg-elev py-1 shadow-lg"
              aria-label="Jump to bottom"
              onClick={() => void scrollToBottom({ animation: "smooth" })}
            >
              <ArrowDown size={14} weight="bold" />
              <KbdShortcut combo={comboFor("jumpToChatBottom")} />
            </Button>
          </div>
        )}
      </div>

      {streams.length > 0 && (
        <div className="grid flex-none gap-2 border-t border-border px-4 pb-3 pt-3">
          {streams.map((stream) => (
            <StreamingMessage
              key={stream.targetSessionId}
              text={stream.text}
              target={targetLabelFor(stream.targetSessionId)}
              model={stream.model}
            />
          ))}
        </div>
      )}

      <footer className="grid flex-none gap-2 border-t border-border bg-elev px-4 pb-[14px] pt-3">
        <div className="grid gap-2" aria-live="polite">
          <div className="flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[10px]">
            {addressee && (
              <>
                <span className="uppercase tracking-[0.06em] text-fg-faint">to</span>
                <span className="text-fg-dim">{formatAddressee(addressee, attachedInChat)}</span>
              </>
            )}
          </div>
          <ComposerTargetIndicators
            sessions={sessionsInChat}
            liveStateById={liveStateById}
            addresseeId={addressee?.id}
            onFocusSession={onFocusSession}
          />
        </div>
        <ChatComposer
          ref={composerHandleRef}
          value={draft}
          disabled={sending}
          candidates={candidates}
          onSelectTarget={setTargetOverride}
          onMention={ensureFilesLoaded}
          filesTruncated={filesTruncated}
          onChange={(next) => {
            setDraft(next)
            if (composerError) setComposerError(undefined)
          }}
          onSend={() => void sendPrompt()}
        />
        <div className="flex flex-wrap items-baseline justify-end gap-x-3 gap-y-2">
          {composerError && (
            <span className="mr-auto font-mono text-[11px] text-danger">{composerError}</span>
          )}
          <span className="inline-flex items-center gap-1.5 font-mono text-[10px] text-fg-faint">
            <KbdShortcut combo={comboFor("sendMessage")} /> send
          </span>
        </div>
      </footer>
    </section>
  )
  },
)
