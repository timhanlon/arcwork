import { useState } from "react"
import type { ReactNode } from "react"
import { ArcSidebarTree, type ArcSidebarSelection } from "./ArcSidebarTree.js"
import {
  chatsFixture,
  liveStatesFixture,
  pendingSessionIdsFixture,
  sessionsFixture,
  workspacesFixture,
} from "./fixtures.js"

export default {
  title: "Sidebar / ArcSidebarTree",
}

/** The live 280px sidebar column, padded like the App.tsx <aside>. */
function Column({ children }: { readonly children: ReactNode }) {
  return (
    <div style={{ width: 280, maxWidth: "100%", display: "flex", flexDirection: "column", padding: 14 }}>
      {children}
    </div>
  )
}

const noop = (): void => {}

/** Fully populated: two workspaces, chats, and sessions across every status. */
export const Populated = () => {
  const [sel, setSel] = useState<ArcSidebarSelection>({})
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>("target_run")
  return (
    <Column>
      <ArcSidebarTree
        workspaces={workspacesFixture}
        chats={chatsFixture}
        sessions={sessionsFixture}
        activeSessionId={activeSessionId}
        liveStateById={liveStatesFixture}
        pendingSessionIds={pendingSessionIdsFixture}
        selectedWorkspaceId={sel.workspaceId}
        selectedChatId={sel.chatId}
        onSelectChat={noop}
        onSelectSession={(_p, _c, sessionId) => setActiveSessionId(sessionId)}
        onCreateChat={noop}
        onSelectionChange={setSel}
      />
    </Column>
  )
}

/** A workspace with no chats yet — the "no chats yet" empty state. */
export const EmptyWorkspace = () => (
  <Column>
    <ArcSidebarTree
      workspaces={[workspacesFixture[0]!]}
      chats={[]}
      sessions={[]}
      onSelectChat={noop}
      onSelectSession={noop}
      onCreateChat={noop}
    />
  </Column>
)

/** A single workspace with chats but no launched sessions. */
export const SingleWorkspace = () => (
  <Column>
    <ArcSidebarTree
      workspaces={[workspacesFixture[0]!]}
      chats={chatsFixture.filter((c) => c.workspaceId === "workspace_arc")}
      sessions={[]}
      onSelectChat={noop}
      onSelectSession={noop}
      onCreateChat={noop}
    />
  </Column>
)

/** A pending request pulses on a session and surfaces as a chat-row badge. */
export const BusyWithPending = () => (
  <Column>
    <ArcSidebarTree
      workspaces={[workspacesFixture[0]!]}
      chats={chatsFixture.filter((c) => c.workspaceId === "workspace_arc")}
      sessions={sessionsFixture}
      liveStateById={liveStatesFixture}
      pendingSessionIds={pendingSessionIdsFixture}
      onSelectChat={noop}
      onSelectSession={noop}
      onCreateChat={noop}
    />
  </Column>
)
