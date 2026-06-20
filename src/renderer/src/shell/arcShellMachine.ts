import { assign, createMachine, emit, enqueueActions, type ActorRefFrom } from "xstate"

export interface ShellPane {
  readonly id: string
  readonly provider: string
  readonly chatId: string
  readonly sessionId?: string
  readonly resumeSessionId?: string
}

/** A tree pick in the left product surface — what the sidebar emits on select. */
export interface ShellTreeSelection {
  readonly workspaceId?: string
  readonly chatId?: string
  readonly sessionId?: string
}

export interface ShellSessionRef {
  readonly id: string
  readonly provider: string
  readonly chatId: string
  readonly attached: boolean
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
export type CenterSurface =
  | { readonly kind: "chat" }
  | { readonly kind: "work" }
// `git` owns the whole right region — the changed-file list and the selected
// file's diff together (master-detail), carrying its own selected `path`.
export type RightSurface =
  | { readonly kind: "terminal" }
  | { readonly kind: "git"; readonly path?: string }
  | { readonly kind: "work"; readonly workId: string }

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
  | { readonly kind: "work"; readonly workId?: string }
  | { readonly kind: "git"; readonly path?: string }
  | { readonly kind: "terminal" }

export interface ShellLayout {
  readonly left: { readonly surface: LeftSurface; readonly collapsed: boolean }
  readonly center: { readonly surface: CenterSurface }
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
  readonly workspaceId?: string
  readonly chatId?: string
  readonly sessionId?: string
  readonly terminalPaneId?: string
  readonly chatByWorkspace: Readonly<Record<string, string>>
  readonly gitPathByWorkspace: Readonly<Record<string, string>>
  readonly workByWorkspace: Readonly<Record<string, string>>
}

export interface ArcShellContext {
  // Layout (regions + surfaces) and selection (product picks) are the two halves
  // the shell separates; the fields below are session runtime that belongs to
  // neither.
  readonly layout: ShellLayout
  readonly selection: ShellSelection
  readonly panes: ReadonlyArray<ShellPane>
  readonly detachedSessionId?: string
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
      readonly workspaceId: string
      readonly chatId: string
    }
  | {
      readonly type: "SIDEBAR_SELECTION_CHANGED"
      readonly selection: ShellTreeSelection
    }
  | { readonly type: "SURFACE_OPENED"; readonly target: OpenTarget; readonly pane: Pane }
  | {
      readonly type: "TARGET_LAUNCH_REQUESTED"
      readonly paneId: string
      readonly provider: string
      readonly chatId: string
      readonly workspaceId?: string
    }
  | {
      readonly type: "TARGET_BOUND"
      readonly paneId: string
      readonly sessionId: string
    }
  | {
      readonly type: "SESSION_FOCUSED"
      readonly paneId: string
      readonly session: ShellSessionRef
      readonly workspaceId?: string
    }
  | {
      readonly type: "TARGET_ADOPTED"
      readonly paneId: string
      readonly session: ShellSessionRef
    }
  | {
      readonly type: "DETACHED_RESUME_REQUESTED"
      readonly paneId: string
      readonly session: ShellSessionRef
      readonly workspaceId?: string
    }
  | {
      readonly type: "PTY_EXITED"
      readonly sessionId: string
    }
  | {
      readonly type: "SESSION_STOP_REQUESTED"
      readonly sessionId: string
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

const showCenter = (layout: ShellLayout, surface: CenterSurface): ShellLayout => ({
  ...layout,
  center: { surface },
})

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
    if (target.kind === "chat") return { layout: showCenter(context.layout, { kind: "chat" }) }
    if (target.kind === "work") {
      // The navigator always becomes the visible center view; the workId is the
      // *selection*, remembered per workspace. A workId selects + remembers it; an
      // absent workId is a deselect — back to the list, forgetting the pick — so a
      // later re-entry shows the list rather than springing back to a stale item.
      // (Re-entry from the NavBar passes the remembered id back in to restore it.)
      const ws = context.selection.workspaceId
      const layout = showCenter(context.layout, { kind: "work" })
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
    return {}
  }
  if (target.kind === "terminal") return { layout: showRight(context.layout, { kind: "terminal" }) }
  if (target.kind === "work") {
    return target.workId ? { layout: showRight(context.layout, { kind: "work", workId: target.workId }) } : {}
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
  workspaceId: string,
  chatId: string,
): ArcShellContext => ({
  ...context,
  selection: {
    ...context.selection,
    workspaceId,
    chatId,
    sessionId: undefined,
    chatByWorkspace: { ...context.selection.chatByWorkspace, [workspaceId]: chatId },
  },
  layout: showCenter(context.layout, { kind: "chat" }),
})

const closePaneForSession = (
  context: ArcShellContext,
  sessionId: string,
): { readonly panes: ReadonlyArray<ShellPane>; readonly terminalPaneId?: string } => {
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
    center: { surface: { kind: "chat" } },
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
  context: initialArcShellContext,
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
        TARGET_LAUNCH_REQUESTED: {
          actions: [
            assign(({ context, event }) => {
              const base = event.workspaceId
                ? selectChat(context, event.workspaceId, event.chatId)
                : { ...context, layout: showCenter(context.layout, { kind: "chat" as const }) }
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
              }
            }
            return {
              panes: context.panes.map((pane) =>
                pane.id === event.paneId
                  ? { ...pane, sessionId: event.sessionId, resumeSessionId: undefined }
                  : pane,
              ),
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
              const base = event.workspaceId
                ? selectChat(context, event.workspaceId, event.session.chatId)
                : { ...context, layout: showCenter(context.layout, { kind: "chat" as const }) }
              const right = { surface: { kind: "terminal" as const }, collapsed: false }

              if (!event.session.attached) {
                return {
                  ...base,
                  layout: { ...base.layout, right },
                  detachedSessionId: event.session.id,
                  selection: {
                    ...base.selection,
                    workspaceId: event.workspaceId ?? base.selection.workspaceId,
                    chatId: event.session.chatId,
                    sessionId: event.session.id,
                  },
                }
              }

              const existing = base.panes.find((pane) => pane.sessionId === event.session.id)
              if (existing) {
                return {
                  ...base,
                  layout: { ...base.layout, right },
                  selection: { ...base.selection, terminalPaneId: existing.id },
                  detachedSessionId: undefined,
                }
              }

              const pane: ShellPane = {
                id: event.paneId,
                provider: event.session.provider,
                chatId: event.session.chatId,
                sessionId: event.session.id,
              }
              return {
                ...base,
                layout: { ...base.layout, right },
                panes: [...base.panes, pane],
                selection: { ...base.selection, terminalPaneId: pane.id },
                detachedSessionId: undefined,
              }
            })
            if (event.type === "SESSION_FOCUSED" && event.session.attached) {
              enqueue.emit({ type: "focusTerminal" })
            }
          }),
        },
        DETACHED_RESUME_REQUESTED: {
          actions: [
            assign(({ context, event }) => {
              const base = event.workspaceId
                ? selectChat(context, event.workspaceId, event.session.chatId)
                : { ...context, layout: showCenter(context.layout, { kind: "chat" as const }) }
              const right = { surface: { kind: "terminal" as const }, collapsed: false }
              const existing = base.panes.find((pane) => pane.sessionId === event.session.id)
              if (existing) {
                return {
                  ...base,
                  layout: { ...base.layout, right },
                  selection: { ...base.selection, terminalPaneId: existing.id },
                  detachedSessionId: undefined,
                }
              }
              const pane: ShellPane = {
                id: event.paneId,
                provider: event.session.provider,
                chatId: event.session.chatId,
                sessionId: event.session.id,
                resumeSessionId: event.session.id,
              }
              return {
                ...base,
                layout: { ...base.layout, right },
                panes: [...base.panes, pane],
                selection: { ...base.selection, terminalPaneId: pane.id },
                detachedSessionId: undefined,
              }
            }),
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
              layout: showCenter(context.layout, { kind: "chat" }),
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
              layout: showCenter(context.layout, { kind: "chat" }),
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
              layout: showCenter(context.layout, { kind: "work" }),
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
