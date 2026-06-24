import type { Workspace } from "../../../shared/workspace.js"
import type { Chat } from "../../../shared/chat.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { LiveTargetActivity, LiveTargetState } from "../../../shared/live-target-state.js"
import type { PendingRequest } from "../../../shared/chat-request.js"
import type { Work, WorkPriority, WorkProvenance } from "../../../shared/work.js"
import { arcId } from "../../../shared/ids.js"
import type { LiveStateById } from "./grouping.js"

/** Stable reference clock so createdAt ordering in stories is deterministic. */
export const REFERENCE_NOW = "2026-06-07T17:00:00.000Z"

export function workspace(
  over: Partial<Omit<Workspace, "id">> & { readonly id: string },
): Workspace {
  return {
    path: "/Users/you/dev/arc-test",
    name: "arc-test",
    repositoryId: null,
    repoLabel: null,
    defaultBranch: null,
    branch: null,
    isWorktree: false,
    pullRequest: null,
    ...over,
    id: arcId("workspace", over.id),
  }
}

export function chat(
  over: Partial<Omit<Chat, "id" | "workspaceId">> & {
    readonly id: string
    readonly workspaceId: string
    readonly title: string
  },
): Chat {
  return {
    _tag: "Chat",
    createdAt: REFERENCE_NOW,
    ...over,
    id: arcId("chat", over.id),
    workspaceId: arcId("workspace", over.workspaceId),
  }
}

export function workItem(
  over: Partial<Omit<Work, "id" | "nodeId" | "provenance">> & {
    readonly id: string
    readonly title: string
    readonly status: Work["status"]
    readonly priority?: WorkPriority
    readonly provenance?: Omit<WorkProvenance, "chatId"> & { readonly chatId?: string }
  },
): Work {
  const { provenance, ...rest } = over
  return {
    _tag: "Work",
    body: "",
    labels: [],
    createdAt: REFERENCE_NOW,
    updatedAt: REFERENCE_NOW,
    citations: [],
    ...rest,
    id: arcId("work", over.id),
    nodeId: arcId("work_rev", `${over.id}_rev`),
    provenance: {
      source: provenance?.source ?? "cli",
      ...provenance,
      chatId: provenance?.chatId == null ? undefined : arcId("chat", provenance.chatId),
    },
    priority: over.priority ?? null,
  }
}

export function session(
  over: Partial<Omit<TargetSession, "id" | "chatId">> & {
    readonly id: string
    readonly chatId: string
    readonly provider: string
  },
): TargetSession {
  return {
    _tag: "TargetSession",
    cwd: "/Users/you/dev/arc-test",
    state: "idle",
    attached: true,
    startedAt: REFERENCE_NOW,
    ...over,
    id: arcId("target", over.id),
    chatId: arcId("chat", over.chatId),
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
  workspace({
    id: "workspace_arc",
    name: "arc-test",
    path: "/Users/you/dev/arc-test",
    repositoryId: "repo_arc",
    repoLabel: "acme/arc",
    defaultBranch: "main",
    branch: "main",
  }),
  workspace({
    id: "workspace_arc_feat",
    name: "arc-feat-git",
    path: "/Users/you/.worktrees/arc-feat-git",
    repositoryId: "repo_arc",
    repoLabel: "acme/arc",
    defaultBranch: "main",
    branch: "feat/git",
    isWorktree: true,
    pullRequest: {
      number: 42,
      title: "feat(git): carry repo identity on the workspace DTO",
      state: "open",
      isDraft: false,
      url: "https://github.com/acme/arc/pull/42",
    },
  }),
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

/** The raw shape the `liveTargetStatesAtom` carries (an array, not the folded
 * Map) — what a story seeds the atom with so the sidebar derives its own
 * `liveStateById` exactly as in the app. */
export const liveTargetStatesFixture: ReadonlyArray<LiveTargetState> = sessionsFixture.flatMap(
  (session) => {
    const activity = liveStatesFixture.get(session.id)
    return activity ? [{ targetSessionId: session.id, chatId: session.chatId, activity }] : []
  },
)

/** The raw shape the `pendingRequestsAtom` carries — what a story seeds so the
 * sidebar flags `target_wait` as awaiting the user. */
export const pendingRequestsFixture: ReadonlyArray<PendingRequest> = sessionsFixture
  .filter((session) => pendingSessionIdsFixture.has(session.id))
  .map((session) => ({ chatId: session.chatId, targetSessionId: session.id, kind: "question" as const }))
