import { useState } from "react"
import type { ReactNode } from "react"
import { WorkspaceTree, type WorkspaceTreeSelection } from "./WorkspaceTree.js"
import {
  chatsFixture,
  liveStatesFixture,
  pendingSessionIdsFixture,
  sessionsFixture,
  workByChatFixture,
  workspacesFixture,
} from "./fixtures.js"

export default {
  title: "Sidebar / WorkspaceTree",
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

/** Interactive prototype: work + targets, collapse-all, phosphor new-chat. */
export const Populated = () => {
  const [sel, setSel] = useState<WorkspaceTreeSelection>({})
  const [activeSessionId, setActiveSessionId] = useState<string | undefined>("target_run")
  return (
    <Column>
      <WorkspaceTree
        workspaces={workspacesFixture}
        chats={chatsFixture}
        sessions={sessionsFixture}
        workByChat={workByChatFixture}
        activeSessionId={activeSessionId}
        liveStateById={liveStatesFixture}
        pendingSessionIds={pendingSessionIdsFixture}
        selectedWorkspaceId={sel.workspaceId}
        selectedChatId={sel.chatId}
        selectedWorkId={sel.workId}
        onSelectChat={noop}
        onSelectSession={(_p, _c, sessionId) => setActiveSessionId(sessionId)}
        onSelectWork={noop}
        onCreateChat={noop}
        onSelectionChange={setSel}
      />
    </Column>
  )
}

/** Work-only chats — no launched targets yet. */
export const WorkWithoutTargets = () => (
  <Column>
    <WorkspaceTree
      workspaces={[workspacesFixture[0]!]}
      chats={chatsFixture.filter((c) => c.workspaceId === "workspace_arc")}
      sessions={[]}
      workByChat={workByChatFixture}
      onSelectChat={noop}
      onSelectSession={noop}
      onCreateChat={noop}
    />
  </Column>
)

/** Empty workspace — new-chat icon still renders in the header. */
export const EmptyWorkspace = () => (
  <Column>
    <WorkspaceTree
      workspaces={[workspacesFixture[0]!]}
      chats={[]}
      sessions={[]}
      onSelectChat={noop}
      onSelectSession={noop}
      onCreateChat={noop}
    />
  </Column>
)
