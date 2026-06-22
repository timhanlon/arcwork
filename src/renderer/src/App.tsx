import { type JSX, useEffect, useMemo, useRef, useState } from "react"
import { useAtomSet, useAtomValue } from "@effect/atom-react"
import { Exit } from "effect"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { Group, Panel, Separator, usePanelRef } from "react-resizable-panels"
import { rpc } from "./rpc-client.js"
import { subscribeWhenReady } from "./bridge.js"
import {
  chatsAtom,
  createChatAtom,
  launchTargetAtom,
  liveTargetStatesAtom,
  openWorkspaceAtom,
  pendingRequestsAtom,
  providersAtom,
  resumeTargetAtom,
  sessionsAtom,
  stopTargetAtom,
  workspacesAtom,
} from "./atoms.js"
import type { LiveTargetActivity } from "../../shared/live-target-state.js"
import { ArcSidebarTree } from "./sidebar/ArcSidebarTree.js"
import { orderedPendingSessionIds } from "./sidebar/grouping.js"
import { TargetSessionPane } from "./chat/TargetSessionPane.js"
import { sync as syncTerminals } from "./terminal/terminalRegistry.js"
import { UnifiedChatPane, type ChatPaneHandle } from "./chat/UnifiedChatPane.js"
import { WorkPane, type WorkPaneHandle } from "./work/WorkPane.js"
import { GitPane } from "./git/GitPane.js"
import { GitPrefetch } from "./git/GitPrefetch.js"
import { NavBar } from "./shell/NavBar.js"
import { ArcSearchPanel } from "./search/ArcSearchPanel.js"
import { CommandPalette } from "./shell/CommandPalette.js"
import type { Command } from "./shell/commandPaletteModel.js"
import { useArcShell } from "./shell/useArcShell.js"
import { ShellActionsProvider } from "./shell/ShellActionsContext.js"
import { unadoptedSessions } from "./shell/sessionAdoption.js"
import { deriveShellViewModel } from "./shell/shellSelectors.js"
import { useKeyboardShortcuts } from "./shell/useKeyboardShortcuts.js"
import { bindingFor, focusRequestId, REQUEST_SLOTS, type GlobalCommandId } from "./shell/keybindings.js"

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

// `pnpm dev` vs the built/preview app. macOS shows the unpackaged binary as
// "Electron" regardless, so we surface the profile in-app: a nav-bar badge and
// the document title (which also wins the window title over `index.html`'s
// static `<title>Arc Work</title>`).
const isDev = window.arc?.profile === "dev"

export function App(): JSX.Element {
  const workspacesResult = useAtomValue(workspacesAtom)
  const workspaces = useMemo(
    () => (AsyncResult.isSuccess(workspacesResult) ? workspacesResult.value : []),
    [workspacesResult],
  )
  const [searchOpen, setSearchOpen] = useState(false)
  const [commandOpen, setCommandOpen] = useState(false)

  const providersResult = useAtomValue(providersAtom)
  const providers = AsyncResult.isSuccess(providersResult) ? providersResult.value : []

  const sessionsResult = useAtomValue(sessionsAtom)
  const sessions = useMemo(
    () => (AsyncResult.isSuccess(sessionsResult) ? sessionsResult.value : []),
    [sessionsResult],
  )

  const chatsResult = useAtomValue(chatsAtom)
  const chats = useMemo(
    () => (AsyncResult.isSuccess(chatsResult) ? chatsResult.value : []),
    [chatsResult],
  )

  // Imperative RPC commands as mutation atoms (see atoms.ts). `promiseExit` for
  // the ones whose result drives a follow-up (the new chat / bound session);
  // plain set for fire-and-forget. Failures land in each atom's `AsyncResult`,
  // never a `.catch(console.error)`.
  const runCreateChat = useAtomSet(createChatAtom, { mode: "promiseExit" })
  const runOpenWorkspace = useAtomSet(openWorkspaceAtom)
  const runLaunchTarget = useAtomSet(launchTargetAtom, { mode: "promiseExit" })
  const runResumeTarget = useAtomSet(resumeTargetAtom, { mode: "promiseExit" })
  const runStopTarget = useAtomSet(stopTargetAtom)

  const pendingRequestsResult = useAtomValue(pendingRequestsAtom)
  const pendingRequests = useMemo(
    () => (AsyncResult.isSuccess(pendingRequestsResult) ? pendingRequestsResult.value : []),
    [pendingRequestsResult],
  )
  const pendingSessionIds = useMemo(
    () => new Set(pendingRequests.map((request) => request.targetSessionId)),
    [pendingRequests],
  )

  // The live activity projection (generating/idle/waiting/detached/exited),
  // keyed by session id — the single status source the sidebar and composer
  // both read, instead of each re-deriving off the lifecycle `session.state`.
  const liveTargetStatesResult = useAtomValue(liveTargetStatesAtom)
  const liveTargetStates = useMemo(
    () => (AsyncResult.isSuccess(liveTargetStatesResult) ? liveTargetStatesResult.value : []),
    [liveTargetStatesResult],
  )
  const liveStateById = useMemo(
    () => new Map<string, LiveTargetActivity>(liveTargetStates.map((s) => [s.targetSessionId, s.activity])),
    [liveTargetStates],
  )

  // The waiting sessions in sidebar order, capped at the nine ⌘-number slots, and
  // the session id → slot map the tree paints onto each pending row. Both derive
  // from the same ordering so ⌘N and the row's hint always agree.
  const pendingOrder = useMemo(
    () =>
      orderedPendingSessionIds(workspaces, chats, sessions, pendingSessionIds).slice(
        0,
        REQUEST_SLOTS.length,
      ),
    [workspaces, chats, sessions, pendingSessionIds],
  )
  const requestSlots = useMemo(() => {
    const map = new Map<string, number>()
    pendingOrder.forEach((sessionId, index) => map.set(sessionId, index + 1))
    return map
  }, [pendingOrder])

  const shell = useArcShell({ workspaces, chats, sessions })
  const { layout, panes } = shell.state
  const { left, center, right } = layout

  // Everything App renders falls out of the shell state projected onto the
  // server atoms — no derived shell state owned here.
  const vm = useMemo(
    () => deriveShellViewModel(shell.state, { workspaces, chats, sessions }),
    [shell.state, workspaces, chats, sessions],
  )
  const interactiveProviders = providers.filter((p) => p.interactive)

  const centerView = center.surface.kind === "work" ? "work" : "chat"
  const rightView = right.surface.kind === "git" ? "git" : "terminal"

  useEffect(() => {
    document.title = isDev ? "Arc Work (dev)" : "Arc Work"
  }, [])

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
      shell.actions.adoptSession({
        id: session.id,
        provider: session.provider,
        chatId: session.chatId,
        attached: session.attached ?? false,
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
      // no-op when none are open yet. Unlike createWork it's an async RPC, so it
      // runs here rather than as a machine transition (inlined off the stable
      // atom setter to keep this handler map memoized).
      createChat: () => {
        const workspaceId = vm.workspaceId ?? workspaces[0]?.id
        if (!workspaceId) return
        void runCreateChat({ payload: { workspaceId } }).then((exit) => {
          if (Exit.isSuccess(exit)) shell.actions.selectChat(workspaceId, exit.value.id)
        })
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
  }, [shell.actions, pendingOrder, vm.detachedSession, vm.workId, vm.workspaceId, workspaces, runCreateChat])
  useKeyboardShortcuts(shortcutHandlers)

  const createChat = async (workspaceId: string): Promise<void> => {
    const exit = await runCreateChat({ payload: { workspaceId } })
    if (Exit.isSuccess(exit)) shell.actions.selectChat(workspaceId, exit.value.id)
  }

  // Open a worktree as a workspace (minting its row if needed), then start a
  // chat in it — for a worktree that already exists.
  const openWorktreeChat = async (worktreePath: string): Promise<void> => {
    const workspace = await rpc("OpenWorktree", { worktreePath })
    await createChat(workspace.id)
  }

  // Branch a fresh worktree off the repo's default branch, open it, and chat in
  // it — the "start a new isolated line of work" path. baseRef is omitted, so
  // the main side defaults it to the repo's default branch.
  const newWorktreeChat = async (branch: string): Promise<void> => {
    if (!vm.workspaceId) return
    const worktree = await rpc("CreateWorktree", {
      workspaceId: vm.workspaceId,
      branch,
      createBranch: true,
    })
    await openWorktreeChat(worktree.path)
  }

  const renameChat = async (chatId: string, title: string): Promise<void> => {
    await rpc("UpdateChatTitle", { chatId, title })
  }

  // Commands for the ⌘K palette. Leaf commands reuse the shortcut handlers (and
  // borrow their combo for the on-row hint); "New chat in workspace…" opens a
  // second stage over the open workspaces and lands the chat in the chosen one.
  const leafCommand = (id: GlobalCommandId, title: string): Command => ({
    id,
    title,
    combo: bindingFor(id)?.combo,
    run: shortcutHandlers[id],
  })
  const paletteCommands: ReadonlyArray<Command> = [
    {
      id: "newChatInWorkspace",
      title: "New chat in workspace…",
      choosePlaceholder: "choose a workspace",
      choices: workspaces.map((w) => ({ id: w.id, title: w.name, subtitle: w.path })),
      onChoose: (workspaceId) => void createChat(workspaceId),
    },
    {
      id: "newWorktree",
      title: "New worktree…",
      promptPlaceholder: "new branch name",
      onSubmit: (branch) => void newWorktreeChat(branch),
    },
    {
      id: "openWorktree",
      title: "Open worktree…",
      choosePlaceholder: "choose a worktree",
      loadChoices: async () => {
        if (!vm.workspaceId) return []
        const context = await rpc("GetWorkspaceGitContext", { workspaceId: vm.workspaceId })
        return context.worktrees.map((worktree) => ({
          id: worktree.path,
          title: worktree.branch ?? (worktree.path.split("/").pop() ?? worktree.path),
          subtitle: worktree.path,
        }))
      },
      onChoose: (worktreePath) => void openWorktreeChat(worktreePath),
    },
    leafCommand("createChat", "New chat"),
    leafCommand("createWork", "New work item"),
    leafCommand("showChatView", "Show chat"),
    leafCommand("showWorkView", "Show work"),
    leafCommand("showTerminalView", "Show terminal"),
    leafCommand("showGitView", "Show git"),
    leafCommand("toggleLeftPanel", "Toggle left panel"),
    leafCommand("toggleRightPanel", "Toggle right panel"),
    leafCommand("openSearchPalette", "Search…"),
  ]

  const selectChat = (workspaceId: string, chatId: string): void => {
    shell.actions.selectChat(workspaceId, chatId)
  }

  const onLaunch = (provider: string, chatId: string): void => {
    shell.actions.launchTarget(provider, chatId)
  }

  // Opens the native directory picker in the main process; on confirm the new
  // workspace is persisted and pushed back through `workspacesAtom`'s live
  // stream, so there's nothing to refresh here.
  const openWorkspace = (): void => {
    runOpenWorkspace({ payload: undefined })
  }

  const onMeasured = async (paneId: string, cols: number, rows: number): Promise<void> => {
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
  const focusSession = (sessionId: string): void => {
    shell.actions.focusSession(sessionId)
  }

  // Stop a session's live process. Fire-and-forget: the main process signals
  // the child, and the resulting pty exit flows back through `onPtyExit` (pane
  // close) and the `arc:sessions` push (row → detached), so there's no local
  // state to update here.
  const onStopSession = (sessionId: string): void => {
    shell.actions.stopSession(sessionId)
    runStopTarget({ payload: { sessionId } })
  }

  const onResumeDetached = (): void => {
    shell.actions.resumeDetached()
  }

  // Re-attach a detached but resumable session straight from its sidebar row —
  // the live re-attach flows back through the same ResumeTarget pane path.
  const onResumeSession = (sessionId: string): void => {
    shell.actions.resumeSession(sessionId)
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
            <ArcSidebarTree
              workspaces={workspaces}
              chats={chats}
              sessions={sessions}
              activeSessionId={vm.activeSessionId}
              liveStateById={liveStateById}
              pendingSessionIds={pendingSessionIds}
              requestSlots={requestSlots}
              selectedWorkspaceId={vm.workspaceId}
              selectedChatId={vm.chatId}
              onSelectChat={selectChat}
              onSelectSession={(_provider, _sessionChatId, sessionId) => focusSession(sessionId)}
              onStopSession={onStopSession}
              onResumeSession={onResumeSession}
              onCreateChat={createChat}
              onRenameChat={renameChat}
              onSelectionChange={shell.actions.selectSidebar}
            />
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
              activeSessionId={vm.activeSessionId}
              sessionCount={vm.sessionCount}
              providers={interactiveProviders}
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
          ) : (
            <TargetSessionPane
              panes={panes}
              activePaneId={shell.state.selection.terminalPaneId}
              detachedSession={vm.detachedSession}
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
