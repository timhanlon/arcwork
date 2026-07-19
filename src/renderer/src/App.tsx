import { type JSX, lazy, Suspense, useEffect, useMemo, useRef, useState } from "react"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels"
import { isDevProfile, subscribeWhenReady } from "./bridge.js"
import {
  chatsAtom,
  launchTargetAtom,
  openWorkspaceAtom,
  providersAtom,
  resumeTargetAtom,
  sessionsAtom,
  successList,
  workspacesAtom,
} from "./atoms.js"
import type { ChatId, PaneId, TargetId, WorkspaceId } from "../../shared/ids.js"
import type { TargetSession } from "../../shared/instance.js"
import { ArcSidebarTree } from "./sidebar/ArcSidebarTree.js"
import { TargetSessionPane } from "./chat/TargetSessionPane.js"
import { sync as syncTerminals } from "./terminal/terminalRegistry.js"
import { UnifiedChatPane, type ChatPaneHandle, type LaunchableProvider } from "./chat/UnifiedChatPane.js"
import { WorkPane, type WorkPaneHandle } from "./work/WorkPane.js"
import { GitPane } from "./git/GitPane.js"
import { ImageView } from "./ui/ImageView.js"
// Monaco + its Shiki grammars are ~13 MB — a lot to parse on every launch for a
// pane that only appears when a file is opened. Split it behind a lazy import so
// the editor chunk is fetched on first file-open, not at startup.
const WorkspaceFileView = lazy(() =>
  import("./editor/WorkspaceFileView.js").then((m) => ({ default: m.WorkspaceFileView })),
)
import { GitPrefetch } from "./git/GitPrefetch.js"
import { NavBar } from "./shell/NavBar.js"
import { ArcSearchPanel } from "./search/ArcSearchPanel.js"
import { CommandPalette } from "./shell/CommandPalette.js"
import { useArcShell } from "./shell/useArcShell.js"
import { ShellActionsProvider } from "./shell/ShellActionsContext.js"
import { ShellStateProvider } from "./shell/ShellStateContext.js"
import { unadoptedSessions } from "./shell/sessionAdoption.js"
import { deriveShellViewModel } from "./shell/shellSelectors.js"
import { useKeyboardShortcuts } from "./shell/useKeyboardShortcuts.js"
import { focusRequestId, REQUEST_SLOTS, type GlobalCommandId } from "./shell/keybindings.js"
import { buildPaletteCommands } from "./shell/paletteCommands.js"
import { useChatMutations } from "./shell/useChatMutations.js"
import { useSessionActivityProjection } from "./sidebar/useSessionActivityProjection.js"

/**
 * The surface. Sidebar lists workspaces, chats, and sessions. The center pane
 * shows the selected chat; the right pane hosts PTYs — `selection.terminalPaneId`
 * picks the visible terminal regardless of which chat is selected in the center.
 *
 * State is sorted by nature: server state (workspaces/chats/providers/sessions)
 * comes from reactive atoms (see atoms.ts) read as `AsyncResult`; local shell
 * intent (selected chat, open terminal panes, detached-session focus, center
 * view) lives in the XState shell machine.
 *
 * Terminals are keep-alive but their lifetime is owned by the terminal registry
 * (terminalRegistry.ts), not the React tree: every opened session has an xterm +
 * persistent DOM host the registry parks/reparents, so a pane survives both a
 * session switch and a right-surface switch (terminal → git → terminal) without
 * being torn down. The pane `id` is a stable local TypeID so it survives
 * `launch → bound` (its `sessionId` fills in) without losing freshly-spawned
 * output.
 */

export function App(): JSX.Element {
  // `pnpm dev` vs the built/preview app. macOS shows the unpackaged binary as
  // "Electron" regardless, so we surface the profile in-app: a nav-bar badge and
  // the document title (which also wins the window title over `index.html`'s
  // static `<title>Arc Work</title>`). Read in-component (post-mount) so the
  // bridge has attached — see isDevProfile.
  const isDev = isDevProfile()
  const workspaces = successList(useAtomValue(workspacesAtom))
  const [searchOpen, setSearchOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  const providers = successList(useAtomValue(providersAtom))
  const sessions = successList(useAtomValue(sessionsAtom))
  const chats = successList(useAtomValue(chatsAtom))

  // Imperative RPC commands as mutation atoms (see atoms.ts). `promiseExit` for
  // the ones whose result drives a follow-up (the bound session); plain set for
  // fire-and-forget. Failures land in each atom's `AsyncResult`, never a
  // `.catch(console.error)`. (Chat create/rename live in useChatMutations.)
  const runOpenWorkspace = useAtomSet(openWorkspaceAtom)
  const runLaunchTarget = useAtomSet(launchTargetAtom, { mode: "promiseExit" })
  const runResumeTarget = useAtomSet(resumeTargetAtom, { mode: "promiseExit" })
  const { liveStateById, pendingOrder } = useSessionActivityProjection({ workspaces, chats, sessions })

  const shell = useArcShell({ workspaces, chats, sessions })
  const { createChat, renameChat } = useChatMutations(shell.actions.selectChat)
  const { layout, panes } = shell.state
  const { left, center, right } = layout

  // Everything App renders falls out of the shell state projected onto the
  // server atoms — no derived shell state owned here.
  const vm = useMemo(
    () => deriveShellViewModel(shell.state, { workspaces, chats, sessions }),
    [shell.state, workspaces, chats, sessions],
  )
  // One launch option per (provider, runtime): a provider that declares both an
  // `interactive` (PTY TUI) and an `appServer` (codex app-server) capability
  // surfaces both, individually labelled, so the user picks the runtime at launch.
  const launchableProviders: ReadonlyArray<LaunchableProvider> = providers.flatMap((p) => {
    const options: Array<LaunchableProvider> = []
    if (p.interactive) options.push({ kind: p.kind, displayName: p.displayName, runtime: "pty", label: p.kind })
    if (p.appServer)
      options.push({ kind: p.kind, displayName: p.displayName, runtime: "rpc", label: `${p.kind} · app-server` })
    return options
  })

  const centerView = center.surface.kind === "work" ? "work" : "chat"
  const rightView = right.surface.kind === "git" ? "git" : "terminal"

  useEffect(() => {
    document.title = isDev ? "Arc Work (dev)" : "Arc Work"
  }, [isDev])

  useEffect(
    // The preload bridge attaches a beat after the renderer mounts (and re-runs
    // on reload), so subscribe once it's ready rather than racing it — a missed
    // subscription would drop pty-exit events for the whole session.
    () => subscribeWhenReady((arc) => arc.onPtyExit((evt) => shell.actions.ptyExited(evt.sessionId))),
    [shell.actions],
  )

  // Adopt sessions launched out-of-band (an MCP `arc_handoff_create` spawns the
  // implementer straight through TargetSessionManager, so they arrive on
  // `arc:sessions` with no pane). Open a background terminal pane for each so a
  // handoff target is observable like a manual launch, not just a sidebar row.
  // The selector excludes sessions that already have a pane (including a manual
  // launch mid-bind), so this stays idempotent across every `arc:sessions` push.
  useEffect(() => {
    for (const session of unadoptedSessions(sessions, panes)) {
      // rpc (app-server) sessions have no terminal — adopting one would mount an
      // empty xterm (a stray cursor when focused). They live in the chat pane only.
      if (session.runtime === "rpc") continue
      shell.actions.adoptSession({
        id: session.id,
        provider: session.provider,
        chatId: session.chatId,
        attached: session.attached ?? false,
        runtime: session.runtime,
      })
    }
  }, [sessions, panes, shell.actions])

  // The machine owns panel visibility; the resizable panels own the mechanics
  // (animation + restoring the dragged size on re-open). These effects reconcile
  // intent onto the panels. `collapse()`/`expand()` no-op when already in the
  // target state, so this stays stable even when a drag flips state the other
  // way (see `onResize` below).
  const leftPanelRef = usePanelRef()
  const rightPanelRef = usePanelRef()

  useEffect(() => {
    const ref = leftPanelRef.current
    if (!ref) return
    if (left.collapsed) ref.collapse()
    else ref.expand()
  }, [left.collapsed, leftPanelRef])

  useEffect(() => {
    const ref = rightPanelRef.current
    if (!ref) return
    if (right.collapsed) ref.collapse()
    else ref.expand()
  }, [right.collapsed, rightPanelRef])

  // Imperative chat-surface signals. The shell emits one-shot `focusComposer` /
  // `scrollChatToBottom` events alongside the layout transition; App drives the
  // chat pane's handle in response. A request can ride the same transition that
  // *mounts* the pane (⌘L / ⌘↓ from the work view), so defer to the next frame —
  // by then React has committed the mount and the ref points at a live pane.
  // (The terminal's `focusTerminal` is handled in the terminal registry: each
  // entry subscribes for the signal independent of React mount state.)
  const chatPaneRef = useRef<ChatPaneHandle>(null)
  const workPaneRef = useRef<WorkPaneHandle>(null)
  const { actor } = shell.actions
  useEffect(() => {
    const focus = actor.on("focusComposer", () => {
      requestAnimationFrame(() => chatPaneRef.current?.focusComposer())
    })
    const scroll = actor.on("scrollChatToBottom", () => {
      requestAnimationFrame(() => chatPaneRef.current?.scrollToBottom())
    })
    // The new-work command surfaces the work view in the same transition that
    // opens the create form, so defer a frame for the freshly-mounted pane
    // (mirrors focusComposer).
    const create = actor.on("startWorkCreate", () => {
      requestAnimationFrame(() => workPaneRef.current?.startCreate())
    })
    return () => {
      focus.unsubscribe()
      scroll.unsubscribe()
      create.unsubscribe()
    }
  }, [actor])

  const shortcutHandlers = useMemo(() => {
    const handlers = {
      toggleLeftPanel: shell.actions.toggleLeftPanel,
      toggleRightPanel: shell.actions.toggleRightPanel,
      showChatView: () => shell.actions.open({ kind: "chat" }, "center"),
      // Re-entering the work view restores the last-selected item (passing the
      // remembered id back through `open`), rather than landing on the list — an
      // absent workId would read as a deselect and clear the pick.
      showWorkView: () => shell.actions.open({ kind: "work", workId: vm.workId }, "center"),
      // New chat lands in the selected workspace, falling back to the first — a
      // no-op when none are open yet. Unlike createWork it's an async RPC
      // (useChatMutations), so it runs here rather than as a machine transition.
      createChat: () => {
        const workspaceId = vm.workspaceId ?? workspaces[0]?.id
        if (workspaceId) void createChat(workspaceId)
      },
      createWork: shell.actions.createWork,
      showTerminalView: () => shell.actions.open({ kind: "terminal" }, "right"),
      showGitView: () => shell.actions.open({ kind: "git" }, "right"),
      focusComposer: shell.actions.focusComposer,
      openSearchPalette: () => setSearchOpen(true),
      openCommandPalette: () => setCommandOpen(true),
      jumpToChatBottom: shell.actions.jumpChatToBottom,
      resumeDetachedSession: () => {
        if (vm.detachedSession?.resumable) shell.actions.resumeDetached()
      },
    } as Record<GlobalCommandId, () => void>
    for (const slot of REQUEST_SLOTS) {
      handlers[focusRequestId(slot)] = () => {
        const sessionId = pendingOrder[slot - 1]
        if (sessionId) shell.actions.focusSession(sessionId)
      }
    }
    return handlers
  }, [shell.actions, pendingOrder, vm.detachedSession, vm.workId, vm.workspaceId, workspaces, createChat])
  useKeyboardShortcuts(shortcutHandlers)

  const paletteCommands = buildPaletteCommands({
    workspaceId: vm.workspaceId,
    workspacePath: vm.workspace?.path,
    workspaces,
    createChat,
    shortcutHandlers,
  })

  const selectChat = (workspaceId: WorkspaceId, chatId: ChatId): void => {
    shell.actions.selectChat(workspaceId, chatId)
  }

  // rpc launch/resume bypass the shell's pane/measure machinery (no `TARGET_BOUND`
  // to make the session current), so once the RPC returns the session we focus it
  // by ref — making it the composer target without waiting for it to land in the
  // live list (a `focusSession(id)` lookup would race and miss).
  const focusRpcTarget = (session: TargetSession): void => {
    shell.actions.focusTarget({
      id: session.id,
      provider: session.provider,
      chatId: session.chatId,
      attached: session.attached ?? false,
      runtime: session.runtime,
    })
  }

  const onLaunch = (provider: string, chatId: ChatId, runtime: "pty" | "rpc"): void => {
    // An rpc (app-server) session has no terminal, so it skips the pane/measure
    // machinery entirely: fire `LaunchTarget` directly and let the session appear
    // through `WatchSessions`. Its transcript, composer, and approval cards render
    // from that projection — no xterm to bind. PTY launches still go through the
    // shell machine, which creates a pane and defers the RPC until xterm measures.
    if (runtime === "rpc") {
      void runLaunchTarget({ payload: { provider, chatId, runtime: "rpc" } }).then((exit) => {
        if (Exit.isSuccess(exit)) focusRpcTarget(exit.value)
      })
      return
    }
    shell.actions.launchTarget(provider, chatId)
  }

  // Opens the native directory picker in the main process; on confirm the new
  // workspace is persisted and pushed back through `workspacesAtom`'s live
  // stream, so there's nothing to refresh here.
  const openWorkspace = (): void => {
    runOpenWorkspace({ payload: undefined })
  }

  const onMeasured = async (paneId: PaneId, cols: number, rows: number): Promise<void> => {
    const pane = panes.find((p) => p.id === paneId)
    if (!pane || (pane.sessionId && !pane.resumeSessionId)) return
    const exit = await (pane.resumeSessionId
      ? runResumeTarget({ payload: { sessionId: pane.resumeSessionId, cols, rows } })
      : runLaunchTarget({ payload: { provider: pane.provider, chatId: pane.chatId, cols, rows } }))
    if (Exit.isSuccess(exit)) shell.actions.bindTarget(paneId, exit.value.id)
  }
  // `onMeasured` closes over the current `panes`, so mirror it into a ref and feed
  // the registry a stable wrapper — the sync effect then re-runs only when the
  // pane set (or actor) changes, not on every render.
  const onMeasuredRef = useRef(onMeasured)
  onMeasuredRef.current = onMeasured

  // Drive the terminal registry from the machine's pane list, independent of which
  // right-surface is rendered: create xterms lazily, bind session ids, and dispose
  // only when a pane truly closes (PTY exit). This is what lets a terminal survive
  // a terminal → git → terminal switch instead of being torn down with the surface.
  useEffect(() => {
    syncTerminals(
      panes.map((p) => ({
        id: p.id,
        sessionId: p.sessionId,
        measureOnMount: p.resumeSessionId !== undefined,
      })),
      {
        shellActor: actor,
        onMeasured: (paneId, cols, rows) => onMeasuredRef.current(paneId, cols, rows),
      },
    )
  }, [panes, actor])

  // Bring a target session to the foreground from anywhere (sidebar pick, or a
  // pending-question action in the chat). Selects the owning chat, then either
  // surfaces the detached-resume prompt or activates the live pane.
  const focusSession = (sessionId: TargetId): void => {
    shell.actions.focusSession(sessionId)
  }

  const onResumeDetached = (): void => {
    shell.actions.resumeDetached()
  }

  // Whether the detached session can resume into the rpc (app-server) runtime —
  // its provider must declare an appServer capability. Resuming that way fires
  // `ResumeTarget` directly (no pane): the session comes back attached, which
  // clears the detached overlay (it keys on `!attached`) and surfaces it in the
  // chat pane — the resume mirror of the rpc launch entry.
  const detachedProvider = providers.find((p) => p.kind === vm.detachedSession?.provider)
  const canResumeDetachedRpc = Boolean(vm.detachedSession && detachedProvider?.appServer)
  const onResumeDetachedRpc = (): void => {
    if (vm.detachedSession) {
      void runResumeTarget({ payload: { sessionId: vm.detachedSession.id, runtime: "rpc" } }).then(
        (exit) => {
          if (Exit.isSuccess(exit)) focusRpcTarget(exit.value)
        },
      )
    }
  }

  const selectGitPath = (filePath: string): void => {
    shell.actions.open({ kind: "git", path: filePath }, "right")
  }

  return (
    <ShellActionsProvider value={shell.actions}>
      {vm.workspace ? <GitPrefetch workspaceId={vm.workspace.id} /> : null}
      <div className="grid h-full grid-rows-[auto_1fr]">
        {searchOpen ? (
          <ArcSearchPanel
            chats={chats}
            currentChatId={vm.chatId}
            onOpenChat={selectChat}
            onClose={() => setSearchOpen(false)}
          />
        ) : null}
        {commandOpen ? (
          <CommandPalette commands={paletteCommands} onClose={() => setCommandOpen(false)} />
        ) : null}
        <NavBar
          isDev={isDev}
          centerView={centerView}
          rightView={rightView}
          leftPanelCollapsed={left.collapsed}
          rightPanelCollapsed={right.collapsed}
          onCenterViewChange={(view) =>
            shell.actions.open(
              view === "work" ? { kind: "work", workId: vm.workId } : { kind: "chat" },
              "center",
            )
          }
          onRightViewChange={(view) =>
            shell.actions.open(view === "git" ? { kind: "git" } : { kind: "terminal" }, "right")
          }
          onToggleLeftPanel={shell.actions.toggleLeftPanel}
          onToggleRightPanel={shell.actions.toggleRightPanel}
          onOpenWorkspace={openWorkspace}
        />
        <Group orientation="horizontal">
          <Panel
            collapsible
            collapsedSize={0}
            minSize="14%"
            panelRef={leftPanelRef}
            onResize={(size) => {
              const collapsed = size.asPercentage === 0
              if (collapsed !== left.collapsed) shell.actions.setLeftCollapsed(collapsed)
            }}
          >
            <aside className="flex h-full min-h-0 flex-col overflow-hidden">
              {/* Only the sidebar reads shell state through context today; provide
                  it here rather than at the root until another consumer needs it. */}
              <ShellStateProvider value={shell.state}>
                <ArcSidebarTree />
              </ShellStateProvider>
            </aside>
          </Panel>

          <Separator className="w-px flex-none bg-border transition-colors hover:bg-border-strong focus-visible:bg-accent focus-visible:outline-none active:bg-accent" />

          <Panel defaultSize="38%" minSize="24%" className="min-w-[280px]">
            {center.surface.kind === "work" ? (
              <WorkPane
                ref={workPaneRef}
                chatId={vm.chat?.id}
                selectedId={vm.workId}
                onSelectWork={(workId) => shell.actions.open({ kind: "work", workId }, "center")}
              />
            ) : (
              <UnifiedChatPane
                ref={chatPaneRef}
                chat={vm.chat}
                workspace={vm.chatWorkspace}
                sessions={sessions}
                liveStateById={liveStateById}
                activeTargetId={vm.activeTargetId}
                sessionCount={vm.sessionCount}
                providers={launchableProviders}
                onLaunch={onLaunch}
                onFocusSession={focusSession}
                onRenameChat={renameChat}
              />
            )}
          </Panel>

          <Separator className="w-px flex-none bg-border transition-colors hover:bg-border-strong focus-visible:bg-accent focus-visible:outline-none active:bg-accent" />

          <Panel
            collapsible
            collapsedSize={0}
            minSize="14%"
            panelRef={rightPanelRef}
            onResize={(size) => {
              const collapsed = size.asPercentage === 0
              if (collapsed !== right.collapsed) shell.actions.setRightCollapsed(collapsed)
            }}
          >
            {right.surface.kind === "work" ? (
              <WorkPane
                chatId={vm.chat?.id}
                selectedId={right.surface.workId}
                onSelectWork={(workId) =>
                  shell.actions.open(
                    workId ? { kind: "work", workId } : { kind: "terminal" },
                    "right",
                  )
                }
              />
            ) : right.surface.kind === "git" ? (
              <GitPane
                workspace={vm.workspace}
                selectedPath={vm.gitPath}
                onSelectPath={selectGitPath}
              />
            ) : right.surface.kind === "file" ? (
              <Suspense
                fallback={<div className="px-2 py-2 text-[12px] text-fg-dim">Loading…</div>}
              >
                <WorkspaceFileView
                  workspaceId={right.surface.workspaceId}
                  path={right.surface.path}
                  line={right.surface.line}
                  className="h-full"
                />
              </Suspense>
            ) : right.surface.kind === "image" ? (
              <ImageView src={right.surface.src} title={right.surface.title} className="h-full" />
            ) : (
              <TargetSessionPane
                panes={panes}
                activePaneId={shell.state.selection.terminalPaneId}
                detachedSession={vm.detachedSession}
                canResumeRpc={canResumeDetachedRpc}
                onResumeDetachedRpc={onResumeDetachedRpc}
                hasWorkspaces={workspaces.length > 0}
                onResumeDetached={onResumeDetached}
              />
            )}
          </Panel>
        </Group>
      </div>
    </ShellActionsProvider>
  )
}
