import { useEffect } from "react"
import type { ReactNode } from "react"
import { RegistryProvider } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import { arcId } from "../../../shared/ids.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { Workspace } from "../../../shared/workspace.js"
import type { LiveTargetState } from "../../../shared/live-target-state.js"
import type { PendingRequest } from "../../../shared/chat-request.js"
import {
  chatsAtom,
  liveTargetStatesAtom,
  pendingRequestsAtom,
  sessionsAtom,
  workspacesAtom,
} from "../atoms.js"
import { ShellActionsProvider } from "../shell/ShellActionsContext.js"
import { ShellStateProvider } from "../shell/ShellStateContext.js"
import { useArcShell } from "../shell/useArcShell.js"
import { ArcSidebarTree } from "./ArcSidebarTree.js"
import {
  chatsFixture,
  liveTargetStatesFixture,
  pendingRequestsFixture,
  sessionsFixture,
  workspacesFixture,
} from "./fixtures.js"

export default {
  title: "Sidebar / ArcSidebarTree",
}

// Stable empty defaults — an inline `= []` would get a fresh identity each render.
const NO_LIVE_STATES: ReadonlyArray<LiveTargetState> = []
const NO_PENDING: ReadonlyArray<PendingRequest> = []

/** The live 280px sidebar column, padded like the App.tsx <aside>. */
function Column({ children }: { readonly children: ReactNode }) {
  return (
    <div style={{ width: 280, maxWidth: "100%", display: "flex", flexDirection: "column", padding: 14 }}>
      {children}
    </div>
  )
}

interface SidebarStoryProps {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
  readonly liveTargetStates?: ReadonlyArray<LiveTargetState>
  readonly pendingRequests?: ReadonlyArray<PendingRequest>
  /** Focus a session on mount so the story shows the "active" treatment. */
  readonly focusSessionId?: string
}

/**
 * The whole point of the refactor: `ArcSidebarTree` reads its data off the server
 * atoms and its selection off the shell — so a story renders the *real* component
 * by supplying that environment, not by reshaping the component into props. The
 * registry is seeded with fixture atom values (the hydration path), and a real
 * `arcShellMachine` actor is mounted so clicks (select / disclosure / focus) drive
 * actual state instead of faked `useState`.
 */
function SidebarStory({
  workspaces,
  chats,
  sessions,
  liveTargetStates = NO_LIVE_STATES,
  pendingRequests = NO_PENDING,
  focusSessionId,
}: SidebarStoryProps) {
  return (
    <RegistryProvider
      initialValues={[
        [workspacesAtom, AsyncResult.success(workspaces)],
        [chatsAtom, AsyncResult.success(chats)],
        [sessionsAtom, AsyncResult.success(sessions)],
        [liveTargetStatesAtom, AsyncResult.success(liveTargetStates)],
        [pendingRequestsAtom, AsyncResult.success(pendingRequests)],
      ]}
    >
      <SeededShell workspaces={workspaces} chats={chats} sessions={sessions} focusSessionId={focusSessionId}>
        <Column>
          <ArcSidebarTree />
        </Column>
      </SeededShell>
    </RegistryProvider>
  )
}

function SeededShell({
  workspaces,
  chats,
  sessions,
  focusSessionId,
  children,
}: {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
  readonly focusSessionId?: string
  readonly children: ReactNode
}) {
  const shell = useArcShell({ workspaces, chats, sessions })
  const { focusSession } = shell.actions
  useEffect(() => {
    if (focusSessionId !== undefined) focusSession(arcId("target", focusSessionId))
  }, [focusSessionId, focusSession])
  return (
    <ShellStateProvider value={shell.state}>
      <ShellActionsProvider value={shell.actions}>{children}</ShellActionsProvider>
    </ShellStateProvider>
  )
}

/** Fully populated: two workspaces, chats, and sessions across every status. */
export const Populated = () => (
  <SidebarStory
    workspaces={workspacesFixture}
    chats={chatsFixture}
    sessions={sessionsFixture}
    liveTargetStates={liveTargetStatesFixture}
    pendingRequests={pendingRequestsFixture}
    focusSessionId="target_run"
  />
)

/** A workspace with no chats yet — the "no chats yet" empty state. */
export const EmptyWorkspace = () => (
  <SidebarStory workspaces={workspacesFixture.slice(0, 1)} chats={[]} sessions={[]} />
)

/** A single workspace with chats but no launched sessions. */
export const SingleWorkspace = () => (
  <SidebarStory
    workspaces={workspacesFixture.slice(0, 1)}
    chats={chatsFixture.filter((c) => c.workspaceId === "workspace_arc")}
    sessions={[]}
  />
)

/** A pending request pulses on a session and surfaces as a chat-row badge. */
export const BusyWithPending = () => (
  <SidebarStory
    workspaces={workspacesFixture.slice(0, 1)}
    chats={chatsFixture.filter((c) => c.workspaceId === "workspace_arc")}
    sessions={sessionsFixture}
    liveTargetStates={liveTargetStatesFixture}
    pendingRequests={pendingRequestsFixture}
  />
)
