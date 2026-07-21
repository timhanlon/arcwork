import { assign, createMachine, emit, enqueueActions, type ActorRefFrom } from "xstate"
import { Schema } from "effect"
import {
  ChatId,
  type PaneId,
  type TargetId,
  type WorkId,
  WorkspaceId,
} from "../../../shared/ids.js"

export interface ShellPane {
  readonly id: PaneId
  readonly provider: string
  readonly chatId: ChatId
  readonly sessionId?: TargetId
  readonly resumeSessionId?: TargetId
}

/** A tree pick in the left product surface — what the sidebar emits on select. */
export interface ShellTreeSelection {
  readonly workspaceId?: WorkspaceId
  readonly chatId?: ChatId
  readonly sessionId?: TargetId
}

export interface ShellSessionRef {
  readonly id: TargetId
  readonly provider: string
  readonly chatId: ChatId
  readonly attached: boolean
  /** `rpc` (app-server, no terminal) or `pty`/absent (terminal). Focus skips the
   * terminal pane for an rpc session so it doesn't mount an empty xterm. */
  readonly runtime?: "pty" | "rpc"
}

// Layout is *where* things render — three named regions, each holding a product
// surface plus its own collapsed flag (center never collapses). A surface is a
// discriminated kind so a region can't drift into an illegal state the way the
// old flat `rightView` + `rightWorkId` pair could (terminal kind but a work id
// hanging off the side). Naming stays placement-free: `workspaceTree` is the
// surface, `left` is the region it happens to live in.
export type LeftSurface = { readonly kind: "workspaceTree" }
// The center holds exactly one product view — chat or work. It is never touched
// by git: git is self-contained in the right region (file list + diff), so the
// center no longer carries a `restore` slot or a `gitDiff` overlay. The center
// work view is the navigator (list ↔ detail); *which* item is selected is a
// product pick, so it lives in `selection.workByWorkspace`, not on the surface —
// the surface only records that the navigator is the visible center view.
export type CenterTab =
  | { readonly id: "chat"; readonly kind: "chat" }
  | { readonly id: "work"; readonly kind: "work" }
  | { readonly id: string; readonly kind: "file"; readonly workspaceId: WorkspaceId; readonly path: string; readonly line?: number }
// `git` owns the whole right region — the changed-file list and the selected
// file's diff together (master-detail), carrying its own selected `path`.
export type RightSurface =
  | { readonly kind: "terminal" }
  | { readonly kind: "files" }
  | { readonly kind: "git"; readonly path?: string }
  | { readonly kind: "work"; readonly workId: WorkId }
  // A read-only view of one workspace file (the Monaco editor), named by
  // workspace id + relative path — the same identity the file/diff RPCs use.
  // `line` is the 1-based line to reveal when the link carried one (`foo.ts:7`).
  // An image viewed in-app: a tool result's picture, or an image file-link
  // (including outside every workspace, e.g. `/tmp`). Keyed by its `arc-img://`
  // src rather than a workspace id + relative path, since images aren't confined
  // to a workspace root. `title` is an optional caption (e.g. the file name).
  | { readonly kind: "image"; readonly src: string; readonly title?: string }

// The one verb for moving a surface into a region: `open(target, pane)`. The
// target is the *what* (a tagged surface), the pane the *where* — replacing the
// per-feature verbs (setCenterView / setRightView / openWorkInRightPane /
// selectGitPath / closeRightWork) that each baked a fixed what+where into a name.
// Not every (target, pane) pair is legal — terminal/git only go right, chat only
// center; the machine ignores illegal pairs rather than the verb set encoding the
// legal ones by which functions happen to exist.
export type Pane = "center" | "right"
export type OpenTarget =
  | { readonly kind: "chat" }
  | { readonly kind: "work"; readonly workId?: WorkId }
  | { readonly kind: "git"; readonly path?: string }
  | { readonly kind: "terminal" }
  | { readonly kind: "files" }
  | {
      readonly kind: "file"
      readonly workspaceId: WorkspaceId
      readonly path: string
      readonly line?: number
    }
  | { readonly kind: "image"; readonly src: string; readonly title?: string }

export interface ShellLayout {
  readonly left: { readonly surface: LeftSurface; readonly collapsed: boolean }
  readonly center: { readonly tabs: ReadonlyArray<CenterTab>; readonly activeId: string }
  readonly right: { readonly surface: RightSurface; readonly collapsed: boolean }
}

// Selection is *what* product objects are picked, independent of where anything
// renders. `terminalPaneId` names the live pane the right region surfaces when
// it shows the terminal; the `*ByWorkspace` maps remember a per-workspace pick
// (last chat, last git path, last work item) so switching workspaces — or just
// leaving the work view and coming back — restores context. The work navigator's
// selected item rides this map (not the layout surface) for the same reason the
// git path does: it's a product pick, and it must survive a surface switch.
export interface ShellSelection {
  readonly workspaceId?: WorkspaceId
  readonly chatId?: ChatId
  readonly sessionId?: TargetId
  readonly terminalPaneId?: PaneId
  readonly chatByWorkspace: Readonly<Record<WorkspaceId, ChatId>>
  readonly gitPathByWorkspace: Readonly<Record<WorkspaceId, string>>
  readonly workByWorkspace: Readonly<Record<WorkspaceId, WorkId>>
}

// The slice of selection that survives an app restart, seeded back into the
// machine as `input`. Just which workspace/chat were last open plus the
// per-workspace last-chat map — layout, panes, and live session ids are
// deliberately excluded because they name in-memory runtime that's gone on boot.
// A Schema (not a bare interface) so the persistence layer can decode untrusted
// localStorage JSON through it, rejecting malformed or stale-shaped payloads —
// the branded id schemas also reject ids that aren't valid TypeIDs.
export const PersistedShellSelection = Schema.Struct({
  workspaceId: Schema.optional(WorkspaceId),
  chatId: Schema.optional(ChatId),
  chatByWorkspace: Schema.Record(WorkspaceId, ChatId),
})
export type PersistedShellSelection = typeof PersistedShellSelection.Type

export interface ArcShellContext {
  // Layout (regions + surfaces) and selection (product picks) are the two halves
  // the shell separates; the fields below are session runtime that belongs to
  // neither.
  readonly layout: ShellLayout
  readonly selection: ShellSelection
  readonly panes: ReadonlyArray<ShellPane>
  readonly detachedSessionId?: TargetId
  /** The current composer target — which target the user is talking to — set on
   * every focus/bind regardless of runtime, and followed on pane lifecycle. The
   * PTY-pane-focus half lives in `selection.terminalPaneId`; this is the other
   * half, so a paneless (rpc/SDK) target can be current too. Live runtime state,
   * not persisted; resolved against the live session list in the selector. */
  readonly activeTargetId?: TargetId
}

// One-shot imperative signals the shell fires alongside its state transitions.
// These are *events*, not state: "focus this surface now", "scroll to the
// latest message now". Modelling them as XState `emit`s (rather than monotonic
// epoch counters parked in context) keeps the machine declarative — App
// subscribes via `actor.on(...)` and drives the matching imperative handle,
// instead of threading a counter through every prop chain and guarding its
// resting `0`. Re-firing is free: each emit is a fresh event, so re-focusing an
// already-active surface just works.
export type ArcShellEmitted =
  | { readonly type: "focusComposer" }
  | { readonly type: "focusTerminal" }
  | { readonly type: "scrollChatToBottom" }
  | { readonly type: "startWorkCreate" }

export type ArcShellEvent =
  | {
      readonly type: "CHAT_SELECTED"
      readonly workspaceId: WorkspaceId
      readonly chatId: ChatId
    }
  | {
      readonly type: "SIDEBAR_SELECTION_CHANGED"
      readonly selection: ShellTreeSelection
    }
  | { readonly type: "SURFACE_OPENED"; readonly target: OpenTarget; readonly pane: Pane }
  | { readonly type: "CENTER_TAB_CLOSED"; readonly id: string }
  | {
      readonly type: "TARGET_LAUNCH_REQUESTED"
      readonly paneId: PaneId
      readonly provider: string
      readonly chatId: ChatId
      readonly workspaceId?: WorkspaceId
    }
  | {
      readonly type: "TARGET_BOUND"
      readonly paneId: PaneId
      readonly sessionId: TargetId
    }
  | {
      readonly type: "SESSION_FOCUSED"
      readonly paneId: PaneId
      readonly session: ShellSessionRef
      readonly workspaceId?: WorkspaceId
    }
  | {
      readonly type: "TARGET_ADOPTED"
      readonly paneId: PaneId
      readonly session: ShellSessionRef
    }
  | {
      readonly type: "DETACHED_RESUME_REQUESTED"
      readonly paneId: PaneId
      readonly session: ShellSessionRef
      readonly workspaceId?: WorkspaceId
    }
  | {
      readonly type: "PTY_EXITED"
      readonly sessionId: TargetId
    }
  | {
      readonly type: "SESSION_STOP_REQUESTED"
      readonly sessionId: TargetId
    }
  | { readonly type: "COMPOSER_FOCUS_REQUESTED" }
  | { readonly type: "CHAT_JUMP_TO_BOTTOM_REQUESTED" }
  | { readonly type: "WORK_CREATE_REQUESTED" }
  | { readonly type: "LEFT_PANEL_TOGGLED" }
  | { readonly type: "RIGHT_PANEL_TOGGLED" }
  | { readonly type: "LEFT_PANEL_COLLAPSED_CHANGED"; readonly collapsed: boolean }
  | { readonly type: "RIGHT_PANEL_COLLAPSED_CHANGED"; readonly collapsed: boolean }

// --- Pure layout transitions ----------------------------------------------
// Each region holds one surface; moving one never reaches across to another.
// Git is self-contained in the right region now, so there are no cross-pane
// helpers to keep a center/right pair consistent.

const fileTabId = (workspaceId: WorkspaceId, path: string): string => `file:${workspaceId}:${path}`

const showCenter = (layout: ShellLayout, tab: CenterTab): ShellLayout => {
  const existing = layout.center.tabs.find((candidate) => candidate.id === tab.id)
  return {
    ...layout,
    center: {
      tabs: existing ? layout.center.tabs.map((candidate) => (candidate.id === tab.id ? tab : candidate)) : [...layout.center.tabs, tab],
      activeId: tab.id,
    },
  }
}

const closeCenterTab = (layout: ShellLayout, id: string): ShellLayout => {
  // Chat is the permanent home tab; every other center surface is explicitly
  // opened and may be closed.
  if (id === "chat") return layout
  const index = layout.center.tabs.findIndex((tab) => tab.id === id)
  if (index < 0) return layout
  const tabs = layout.center.tabs.filter((tab) => tab.id !== id)
  const fallback = tabs[Math.max(0, index - 1)] ?? tabs[0]
  if (!fallback) return layout
  return { ...layout, center: { tabs, activeId: layout.center.activeId === id ? fallback.id : layout.center.activeId } }
}

const showRight = (layout: ShellLayout, surface: RightSurface): ShellLayout => ({
  ...layout,
  right: { surface, collapsed: false },
})

// Reveal the git region on the right, seeding the selection with the workspace's
// remembered path (so re-entering git reopens the last file's diff). The file
// list shows immediately; the diff fills in for `path`. The center is untouched.
const enterGit = (context: ArcShellContext): ShellLayout => {
  const { workspaceId, gitPathByWorkspace } = context.selection
  const path = workspaceId ? gitPathByWorkspace[workspaceId] : undefined
  return showRight(context.layout, { kind: "git", path })
}

// `open(target, pane)`: place the target surface in the region. Illegal pairs are
// ignored (chat → center only; terminal/git → right only; right-pane work needs a
// workId). Selecting a git path also records it as the workspace's remembered file.
const openSurface = (
  context: ArcShellContext,
  target: OpenTarget,
  pane: Pane,
): Partial<ArcShellContext> => {
  if (pane === "center") {
    if (target.kind === "chat") return { layout: showCenter(context.layout, { id: "chat", kind: "chat" }) }
    if (target.kind === "work") {
      // The navigator always becomes the visible center view; the workId is the
      // *selection*, remembered per workspace. A workId selects + remembers it; an
      // absent workId is a deselect — back to the list, forgetting the pick — so a
      // later re-entry shows the list rather than springing back to a stale item.
      // (Re-entry from the NavBar passes the remembered id back in to restore it.)
      const ws = context.selection.workspaceId
      const layout = showCenter(context.layout, { id: "work", kind: "work" })
      if (!ws) return { layout }
      const { [ws]: _dropped, ...rest } = context.selection.workByWorkspace
      return {
        layout,
        selection: {
          ...context.selection,
          workByWorkspace: target.workId ? { ...rest, [ws]: target.workId } : rest,
        },
      }
    }
    if (target.kind === "file") {
      return {
        layout: showCenter(context.layout, {
          id: fileTabId(target.workspaceId, target.path),
          kind: "file",
          workspaceId: target.workspaceId,
          path: target.path,
          line: target.line,
        }),
      }
    }
    return {}
  }
  if (target.kind === "terminal") return { layout: showRight(context.layout, { kind: "terminal" }) }
  if (target.kind === "work") {
    return target.workId ? { layout: showRight(context.layout, { kind: "work", workId: target.workId }) } : {}
  }
  if (target.kind === "files") return { layout: showRight(context.layout, { kind: "files" }) }
  if (target.kind === "image") {
    return { layout: showRight(context.layout, { kind: "image", src: target.src, title: target.title }) }
  }
  if (target.kind === "git") {
    // No path → reveal git, seeding the remembered file. A path → select + remember it.
    if (target.path === undefined) return { layout: enterGit(context) }
    const ws = context.selection.workspaceId
    return {
      selection: ws
        ? {
            ...context.selection,
            gitPathByWorkspace: { ...context.selection.gitPathByWorkspace, [ws]: target.path },
          }
        : context.selection,
      layout: showRight(context.layout, { kind: "git", path: target.path }),
    }
  }
  return {}
}

const selectChat = (
  context: ArcShellContext,
  workspaceId: WorkspaceId,
  chatId: ChatId,
): ArcShellContext => ({
  ...context,
  selection: {
    ...context.selection,
    workspaceId,
    chatId,
    sessionId: undefined,
    chatByWorkspace: { ...context.selection.chatByWorkspace, [workspaceId]: chatId },
  },
  // Switching chats drops the composer target; focus handlers re-set it, and a
  // bare chat switch falls back to the first attached in-chat target.
  activeTargetId: undefined,
  layout: showCenter(context.layout, { id: "chat", kind: "chat" }),
})

/**
 * Reveal a live session's terminal: select its chat (or just show the chat
 * center), open the right terminal surface, and either focus the pane already
 * showing that session or append a fresh one. `resume` marks a newly-created pane
 * as a detached resume so the terminal remounts the prior PTY. Both paths clear
 * `detachedSessionId` since the session is now bound to a pane.
 *
 * Shared by SESSION_FOCUSED (live branch) and DETACHED_RESUME_REQUESTED, which
 * differ only in that flag. TARGET_LAUNCH_REQUESTED is deliberately not routed
 * here: it mints a pane before any session id exists, so it has no find-or-create
 * step to share.
 */
const attachSessionPane = (
  context: ArcShellContext,
  opts: {
    readonly session: ShellSessionRef
    readonly workspaceId: WorkspaceId | undefined
    readonly paneId: PaneId
    readonly resume?: boolean
  },
): ArcShellContext => {
  const { session, workspaceId, paneId, resume } = opts
  const base = workspaceId
    ? selectChat(context, workspaceId, session.chatId)
    : { ...context, layout: showCenter(context.layout, { id: "chat", kind: "chat" }) }
  const right = { surface: { kind: "terminal" as const }, collapsed: false }
  const existing = base.panes.find((pane) => pane.sessionId === session.id)
  if (existing) {
    return {
      ...base,
      layout: { ...base.layout, right },
      selection: { ...base.selection, terminalPaneId: existing.id },
      detachedSessionId: undefined,
      activeTargetId: session.id,
    }
  }
  const pane: ShellPane = {
    id: paneId,
    provider: session.provider,
    chatId: session.chatId,
    sessionId: session.id,
    ...(resume ? { resumeSessionId: session.id } : {}),
  }
  return {
    ...base,
    layout: { ...base.layout, right },
    panes: [...base.panes, pane],
    selection: { ...base.selection, terminalPaneId: pane.id },
    detachedSessionId: undefined,
    activeTargetId: session.id,
  }
}

const closePaneForSession = (
  context: ArcShellContext,
  sessionId: TargetId,
): { readonly panes: ReadonlyArray<ShellPane>; readonly terminalPaneId?: PaneId } => {
  const closing = context.panes.find((pane) => pane.sessionId === sessionId)
  if (!closing) {
    return { panes: context.panes, terminalPaneId: context.selection.terminalPaneId }
  }

  const panes = context.panes.filter((pane) => pane.id !== closing.id)
  const terminalPaneId =
    context.selection.terminalPaneId === closing.id
      ? panes.length > 0
        ? panes[panes.length - 1]?.id
        : undefined
      : context.selection.terminalPaneId

  return { panes, terminalPaneId }
}

export const initialArcShellContext: ArcShellContext = {
  layout: {
    left: { surface: { kind: "workspaceTree" }, collapsed: false },
    center: { tabs: [{ id: "chat", kind: "chat" }], activeId: "chat" },
    right: { surface: { kind: "terminal" }, collapsed: false },
  },
  selection: {
    chatByWorkspace: {},
    gitPathByWorkspace: {},
    workByWorkspace: {},
  },
  panes: [],
}

export const arcShellMachine = createMachine({
  id: "arcShell",
  types: {
    context: {} as ArcShellContext,
    events: {} as ArcShellEvent,
    emitted: {} as ArcShellEmitted,
  },
  initial: "running",
  // `input` seeds the persisted selection on boot; it stays optional so callers
  // (and tests) can create the actor with no options at all.
  context: ({ input }: { readonly input?: PersistedShellSelection }) => ({
    ...initialArcShellContext,
    selection: { ...initialArcShellContext.selection, ...input },
  }),
  states: {
    running: {
      on: {
        CHAT_SELECTED: {
          actions: assign(({ context, event }) =>
            selectChat(context, event.workspaceId, event.chatId),
          ),
        },
        SIDEBAR_SELECTION_CHANGED: {
          actions: assign(({ context, event }) => ({
            selection: {
              ...context.selection,
              workspaceId: event.selection.workspaceId,
              chatId: event.selection.chatId,
              sessionId: event.selection.sessionId,
            },
          })),
        },
        SURFACE_OPENED: {
          actions: assign(({ context, event }) => openSurface(context, event.target, event.pane)),
        },
        CENTER_TAB_CLOSED: {
          actions: assign(({ context, event }) => ({ layout: closeCenterTab(context.layout, event.id) })),
        },
        TARGET_LAUNCH_REQUESTED: {
          actions: [
            assign(({ context, event }) => {
              const base = event.workspaceId
                ? selectChat(context, event.workspaceId, event.chatId)
                : { ...context, layout: showCenter(context.layout, { id: "chat", kind: "chat" }) }
              const pane: ShellPane = {
                id: event.paneId,
                provider: event.provider,
                chatId: event.chatId,
              }
              return {
                ...base,
                layout: { ...base.layout, right: { surface: { kind: "terminal" }, collapsed: false } },
                panes: [...base.panes, pane],
                selection: { ...base.selection, terminalPaneId: pane.id },
                detachedSessionId: undefined,
              }
            }),
            // Land focus in the composer, not the freshly-mounted terminal: the
            // target's PTY takes seconds to spawn, and grabbing the keyboard for a
            // not-yet-ready terminal blocks the user from typing their first
            // prompt. Launch is a chat-context action — the composer is its home.
            // (Contrast SESSION_FOCUSED / DETACHED_RESUME, which focus the terminal
            // because the user explicitly asked for that session.)
            emit({ type: "focusComposer" }),
          ],
        },
        TARGET_BOUND: {
          actions: assign(({ context, event }) => {
            const duplicate = context.panes.find(
              (pane) => pane.sessionId === event.sessionId && pane.id !== event.paneId,
            )
            if (duplicate) {
              return {
                panes: context.panes.filter((pane) => pane.id !== event.paneId),
                selection: { ...context.selection, terminalPaneId: duplicate.id },
                activeTargetId: event.sessionId,
              }
            }
            return {
              panes: context.panes.map((pane) =>
                pane.id === event.paneId
                  ? { ...pane, sessionId: event.sessionId, resumeSessionId: undefined }
                  : pane,
              ),
              activeTargetId: event.sessionId,
            }
          }),
        },
        TARGET_ADOPTED: {
          // An MCP/handoff launch put a live session on the store without this
          // renderer opening a pane (see sessionAdoption.ts). Mount a background
          // pane so the target is observable like a manual launch — but never
          // grab the keyboard (no focusEpoch bump), reselect the chat, or change
          // the visible surface: an out-of-band spawn must not yank the user out
          // of what they are doing. The pane is only made the active terminal
          // when the terminal region is otherwise empty, so the first spawned
          // target surfaces while later ones wait in the sidebar.
          actions: assign(({ context, event }) => {
            if (context.panes.some((pane) => pane.sessionId === event.session.id)) {
              return {}
            }
            const pane: ShellPane = {
              id: event.paneId,
              provider: event.session.provider,
              chatId: event.session.chatId,
              sessionId: event.session.id,
            }
            return {
              panes: [...context.panes, pane],
              selection: {
                ...context.selection,
                terminalPaneId:
                  context.panes.length === 0 ? pane.id : context.selection.terminalPaneId,
              },
            }
          }),
        },
        SESSION_FOCUSED: {
          // Focus the terminal only when the user lands on a *live* session; the
          // detached branch shows the resume prompt instead and must not grab the
          // keyboard, so the emit is conditional — hence `enqueueActions` over a
          // bare action list.
          actions: enqueueActions(({ enqueue, event }) => {
            enqueue.assign(({ context, event }) => {
              // rpc (app-server): no terminal — mounting a pane shows an empty
              // xterm (a stray cursor). Focus makes it the composer target and
              // surfaces the chat; the right terminal region is left untouched
              // (it's a passive view, not a mirror of the addressee).
              if (event.session.runtime === "rpc") {
                const base = event.workspaceId
                  ? selectChat(context, event.workspaceId, event.session.chatId)
                  : { ...context, layout: showCenter(context.layout, { id: "chat", kind: "chat" }) }
                return {
                  ...base,
                  detachedSessionId: undefined,
                  activeTargetId: event.session.id,
                }
              }
              // Detached: show the resume prompt instead of mounting a pane — keep
              // the session selected but don't grab the terminal (the emit below
              // is gated on `attached`). Live: find-or-create the pane.
              if (!event.session.attached) {
                const base = event.workspaceId
                  ? selectChat(context, event.workspaceId, event.session.chatId)
                  : { ...context, layout: showCenter(context.layout, { id: "chat", kind: "chat" }) }
                return {
                  ...base,
                  layout: {
                    ...base.layout,
                    right: { surface: { kind: "terminal" as const }, collapsed: false },
                  },
                  detachedSessionId: event.session.id,
                  selection: {
                    ...base.selection,
                    workspaceId: event.workspaceId ?? base.selection.workspaceId,
                    chatId: event.session.chatId,
                    sessionId: event.session.id,
                  },
                }
              }
              return attachSessionPane(context, {
                session: event.session,
                workspaceId: event.workspaceId,
                paneId: event.paneId,
              })
            })
            if (
              event.type === "SESSION_FOCUSED" &&
              event.session.attached &&
              event.session.runtime !== "rpc"
            ) {
              enqueue.emit({ type: "focusTerminal" })
            }
          }),
        },
        DETACHED_RESUME_REQUESTED: {
          actions: [
            assign(({ context, event }) =>
              attachSessionPane(context, {
                session: event.session,
                workspaceId: event.workspaceId,
                paneId: event.paneId,
                resume: true,
              }),
            ),
            // Resuming is an explicit "take me to that session" — focus its terminal.
            emit({ type: "focusTerminal" }),
          ],
        },
        PTY_EXITED: {
          actions: assign(({ context, event }) => {
            const { panes, terminalPaneId } = closePaneForSession(context, event.sessionId)
            return {
              panes,
              selection: { ...context.selection, terminalPaneId },
              detachedSessionId:
                context.detachedSessionId === event.sessionId
                  ? undefined
                  : context.detachedSessionId,
              // Follow the composer target to the newly-active pane's session only
              // if the exiting target *was* current — never clobber an active rpc
              // target just because a background PTY pane closed.
              activeTargetId:
                context.activeTargetId === event.sessionId
                  ? panes.find((pane) => pane.id === terminalPaneId)?.sessionId
                  : context.activeTargetId,
            }
          }),
        },
        SESSION_STOP_REQUESTED: {},
        COMPOSER_FOCUS_REQUESTED: {
          // ⌘L means "let me type to my agent": surface the chat (the composer's
          // home) over whatever the center was showing, then emit so the composer
          // takes focus — even when chat was already visible.
          actions: [
            assign(({ context }) => ({
              layout: showCenter(context.layout, { id: "chat", kind: "chat" }),
            })),
            emit({ type: "focusComposer" }),
          ],
        },
        CHAT_JUMP_TO_BOTTOM_REQUESTED: {
          // The transcript lives in the chat view; surface it first (the center may
          // have been showing work/git), then emit so the pane scrolls — even when
          // chat was already visible.
          actions: [
            assign(({ context }) => ({
              layout: showCenter(context.layout, { id: "chat", kind: "chat" }),
            })),
            emit({ type: "scrollChatToBottom" }),
          ],
        },
        WORK_CREATE_REQUESTED: {
          // "Let me author work now": surface the navigator (center) over whatever
          // was showing — the remembered selection is left untouched, the create
          // form just renders over it — then emit so the pane opens the form, even
          // when work was already visible.
          actions: [
            assign(({ context }) => ({
              layout: showCenter(context.layout, { id: "work", kind: "work" }),
            })),
            emit({ type: "startWorkCreate" }),
          ],
        },
        LEFT_PANEL_TOGGLED: {
          actions: assign(({ context }) => ({
            layout: {
              ...context.layout,
              left: { ...context.layout.left, collapsed: !context.layout.left.collapsed },
            },
          })),
        },
        RIGHT_PANEL_TOGGLED: {
          actions: assign(({ context }) => ({
            layout: {
              ...context.layout,
              right: { ...context.layout.right, collapsed: !context.layout.right.collapsed },
            },
          })),
        },
        LEFT_PANEL_COLLAPSED_CHANGED: {
          actions: assign(({ context, event }) => ({
            layout: {
              ...context.layout,
              left: { ...context.layout.left, collapsed: event.collapsed },
            },
          })),
        },
        RIGHT_PANEL_COLLAPSED_CHANGED: {
          actions: assign(({ context, event }) => ({
            layout: {
              ...context.layout,
              right: { ...context.layout.right, collapsed: event.collapsed },
            },
          })),
        },
      },
    },
  },
})

/** A running shell actor — carries the emitted-event types for `actor.on(...)`. */
export type ArcShellActor = ActorRefFrom<typeof arcShellMachine>
