import type { Workspace } from "../../../shared/workspace.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { LiveTargetActivity } from "../../../shared/live-target-state.js"
import type { Work, WorkPriority } from "../../../shared/work.js"
import type { LiveStateById } from "./grouping.js"
import type { ChatScopedWork } from "./WorkspaceTree.js"

/** Stable reference clock so createdAt ordering in stories is deterministic. */
export const REFERENCE_NOW = "2026-06-07T17:00:00.000Z"

export function workspace(over: Partial<Workspace> & Pick<Workspace, "id">): Workspace {
  return { path: "/Users/you/dev/arc-test", name: "arc-test", ...over }
}

export function chat(over: Partial<Chat> & Pick<Chat, "id" | "workspaceId" | "title">): Chat {
  return { _tag: "Chat", createdAt: REFERENCE_NOW, ...over }
}

export function workItem(
  over: Partial<Work> & Pick<Work, "id" | "title" | "status"> & { readonly priority?: WorkPriority },
): Work {
  return {
    _tag: "Work",
    nodeId: `${over.id}_rev`,
    body: "",
    labels: [],
    createdAt: REFERENCE_NOW,
    updatedAt: REFERENCE_NOW,
    provenance: { source: "cli" },
    citations: [],
    ...over,
    priority: over.priority ?? null,
  }
}

export function session(
  over: Partial<TargetSession> & Pick<TargetSession, "id" | "chatId" | "provider">,
): TargetSession {
  return {
    _tag: "TargetSession",
    cwd: "/Users/you/dev/arc-test",
    state: "idle",
    attached: true,
    startedAt: REFERENCE_NOW,
    ...over,
  }
}

/** Every live activity once, so a story can show the whole status vocabulary. */
export const LIVE_ACTIVITIES: ReadonlyArray<LiveTargetActivity> = [
  "generating",
  "waiting_for_input",
  "waiting_for_approval",
  "idle",
  "exited",
  "detached",
]

/** A populated two-workspace tree used by the integration stories. */
export const workspacesFixture: ReadonlyArray<Workspace> = [
  workspace({ id: "workspace_arc", name: "arc-test", path: "/Users/you/dev/arc-test" }),
  workspace({
    id: "workspace_long",
    name: "compound-engineering",
    path: "/Users/you/dev/aux/src/renderer/src/sidebar",
  }),
]

export const chatsFixture: ReadonlyArray<Chat> = [
  chat({ id: "chat_a", workspaceId: "workspace_arc", title: "new chat", createdAt: "2026-06-07T15:00:00.000Z" }),
  chat({ id: "chat_b", workspaceId: "workspace_arc", title: "investigate hook attribution", createdAt: "2026-06-07T15:30:00.000Z" }),
  chat({ id: "chat_empty", workspaceId: "workspace_long", title: "reconcile work status vs derived queue lane state", createdAt: "2026-06-07T16:00:00.000Z" }),
]

export const sessionsFixture: ReadonlyArray<TargetSession> = [
  session({ id: "target_run", chatId: "chat_a", provider: "claude", preset: "opus", state: "running" }),
  session({ id: "target_wait", chatId: "chat_a", provider: "codex", state: "waiting_for_input" }),
  session({ id: "target_detached", chatId: "chat_a", provider: "cursor", attached: false, state: "idle" }),
  session({ id: "target_idle", chatId: "chat_b", provider: "claude", preset: "sonnet", state: "idle" }),
]

/** chat_a's waiting session is awaiting the user, for the "busy" stories. */
export const pendingSessionIdsFixture: ReadonlySet<string> = new Set(["target_wait"])

/** Live activity for the integration tree's sessions — the projection the
 * sidebar/composer read, so the dots show generating/waiting/idle/detached. */
export const liveStatesFixture: LiveStateById = new Map<string, LiveTargetActivity>([
  ["target_run", "generating"],
  ["target_wait", "waiting_for_input"],
  ["target_detached", "detached"],
  ["target_idle", "idle"],
])

/** Authored + mentioned work scoped to chats for WorkspaceTree stories. */
export const workByChatFixture: ReadonlyMap<string, ReadonlyArray<ChatScopedWork>> = new Map([
  [
    "chat_a",
    [
      {
        work: workItem({
          id: "work_hook",
          title: "Investigate hook attribution",
          status: "active",
          priority: "p1",
          provenance: { source: "cli", chatId: "chat_a" },
          labels: ["bug"],
        }),
        relation: "authored",
      },
      {
        work: workItem({
          id: "work_sidebar",
          title: "Collapse-all control for workspace chats",
          status: "open",
          provenance: { source: "cli", chatId: "chat_b" },
          labels: ["ui"],
        }),
        relation: "mentioned",
      },
    ],
  ],
  [
    "chat_b",
    [
      {
        work: workItem({
          id: "work_queue",
          title: "Reconcile work status vs derived queue lanes",
          status: "blocked",
          priority: "p0",
          provenance: { source: "cli", chatId: "chat_b" },
        }),
        relation: "authored",
      },
      {
        work: workItem({
          id: "work_done",
          title: "Ship chat-scoped work list",
          status: "done",
          provenance: { source: "cli", chatId: "chat_a" },
        }),
        relation: "mentioned",
      },
    ],
  ],
])
