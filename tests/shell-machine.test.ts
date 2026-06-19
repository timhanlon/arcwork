import { createActor } from "xstate"
import { describe, expect, it } from "vitest"
import {
  arcShellMachine,
  type ArcShellEmitted,
  type ArcShellEvent,
  type ShellSessionRef,
} from "../src/renderer/src/shell/arcShellMachine.js"

const snapshotAfter = (...events: ReadonlyArray<ArcShellEvent>) => {
  const actor = createActor(arcShellMachine).start()
  for (const event of events) actor.send(event)
  const snapshot = actor.getSnapshot()
  actor.stop()
  return snapshot.context
}

// Collect the imperative signals (focus/scroll) the machine emits while
// processing a sequence of events — the replacement for the old epoch counters.
const emittedAfter = (...events: ReadonlyArray<ArcShellEvent>): ReadonlyArray<ArcShellEmitted["type"]> => {
  const actor = createActor(arcShellMachine).start()
  const emitted: Array<ArcShellEmitted["type"]> = []
  for (const type of ["focusComposer", "focusTerminal", "scrollChatToBottom"] as const) {
    actor.on(type, (event) => emitted.push(event.type))
  }
  for (const event of events) actor.send(event)
  actor.stop()
  return emitted
}

const attachedSession: ShellSessionRef = {
  id: "target_attached",
  provider: "claude",
  chatId: "chat_1",
  attached: true,
}

const detachedSession: ShellSessionRef = {
  id: "target_detached",
  provider: "codex",
  chatId: "chat_2",
  attached: false,
}

describe("arc shell machine", () => {
  it("starts as an active actor that can receive UI events", () => {
    const actor = createActor(arcShellMachine).start()
    expect(actor.getSnapshot().status).toBe("active")
    actor.stop()
  })

  it("launches an unbound pane then binds it to the target session", () => {
    const context = snapshotAfter(
      {
        type: "TARGET_LAUNCH_REQUESTED",
        paneId: "pane_1",
        provider: "claude",
        chatId: "chat_1",
        workspaceId: "workspace_1",
      },
      { type: "TARGET_BOUND", paneId: "pane_1", sessionId: "target_1" },
    )

    expect(context.layout.center.surface.kind).toBe("chat")
    expect(context.selection.chatByWorkspace["workspace_1"]).toBe("chat_1")
    expect(context.selection.terminalPaneId).toBe("pane_1")
    // Launch focuses the composer, not the not-yet-spawned terminal, so the
    // user can type their first prompt while the PTY spins up.
    const emitted = emittedAfter({
      type: "TARGET_LAUNCH_REQUESTED",
      paneId: "pane_1",
      provider: "claude",
      chatId: "chat_1",
      workspaceId: "workspace_1",
    })
    expect(emitted).toEqual(["focusComposer"])
    expect(context.panes).toEqual([
      {
        id: "pane_1",
        provider: "claude",
        chatId: "chat_1",
        sessionId: "target_1",
        resumeSessionId: undefined,
      },
    ])
  })

  it("focuses an attached session by opening a live pane", () => {
    const context = snapshotAfter({
      type: "SESSION_FOCUSED",
      paneId: "pane_attached",
      session: attachedSession,
      workspaceId: "workspace_1",
    })

    expect(context.detachedSessionId).toBeUndefined()
    expect(context.selection.terminalPaneId).toBe("pane_attached")
    expect(context.selection.workspaceId).toBe("workspace_1")
    expect(context.selection.chatId).toBe("chat_1")
    expect(context.selection.sessionId).toBeUndefined()
    expect(context.panes).toEqual([
      {
        id: "pane_attached",
        provider: "claude",
        chatId: "chat_1",
        sessionId: "target_attached",
      },
    ])
  })

  it("opens the terminal panel when focusing an attached session", () => {
    const context = snapshotAfter(
      { type: "RIGHT_PANEL_TOGGLED" },
      {
        type: "SESSION_FOCUSED",
        paneId: "pane_attached",
        session: attachedSession,
        workspaceId: "workspace_1",
      },
    )

    expect(context.layout.right.collapsed).toBe(false)
    expect(context.layout.right.surface.kind).toBe("terminal")
    expect(context.selection.terminalPaneId).toBe("pane_attached")
  })

  it("opens work in the right pane and returns to terminal mode on close", () => {
    const opened = snapshotAfter(
      { type: "RIGHT_PANEL_TOGGLED" },
      { type: "SURFACE_OPENED", target: { kind: "work", workId: "work_01abc" }, pane: "right" },
    )
    expect(opened.layout.right.collapsed).toBe(false)
    expect(opened.layout.right.surface).toEqual({ kind: "work", workId: "work_01abc" })

    const closed = snapshotAfter(
      { type: "RIGHT_PANEL_TOGGLED" },
      { type: "SURFACE_OPENED", target: { kind: "work", workId: "work_01abc" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "terminal" }, pane: "right" },
    )
    expect(closed.layout.right.collapsed).toBe(false)
    expect(closed.layout.right.surface.kind).toBe("terminal")
  })

  it("replaces right-pane work when focusing a target session", () => {
    const context = snapshotAfter(
      { type: "SURFACE_OPENED", target: { kind: "work", workId: "work_01abc" }, pane: "right" },
      {
        type: "SESSION_FOCUSED",
        paneId: "pane_attached",
        session: attachedSession,
        workspaceId: "workspace_1",
      },
    )

    expect(context.layout.right.surface.kind).toBe("terminal")
    expect(context.selection.terminalPaneId).toBe("pane_attached")
    expect(context.layout.right.collapsed).toBe(false)
  })

  it("surfaces git in the right pane without touching the center", () => {
    const inGit = snapshotAfter({ type: "SURFACE_OPENED", target: { kind: "git" }, pane: "right" })
    expect(inGit.layout.right.surface.kind).toBe("git")
    expect(inGit.layout.right.collapsed).toBe(false)
    // Git is self-contained in the right region — the center is untouched.
    expect(inGit.layout.center.surface.kind).toBe("chat")
  })

  it("records the selected path on the right git surface, leaving the center alone", () => {
    const context = snapshotAfter(
      { type: "CHAT_SELECTED", workspaceId: "workspace_1", chatId: "chat_1" },
      { type: "SURFACE_OPENED", target: { kind: "git" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "git", path: "src/app.ts" }, pane: "right" },
    )
    expect(context.layout.right.surface).toEqual({ kind: "git", path: "src/app.ts" })
    expect(context.layout.center.surface.kind).toBe("chat")
    expect(context.selection.gitPathByWorkspace["workspace_1"]).toBe("src/app.ts")
  })

  it("never disturbs the center across the whole git lifecycle", () => {
    // Enter git from the work view, pick a file, leave git: the center stays on
    // work the entire time — git never overlays or restores it.
    const context = snapshotAfter(
      { type: "SURFACE_OPENED", target: { kind: "work" }, pane: "center" },
      { type: "SURFACE_OPENED", target: { kind: "git" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "git", path: "src/app.ts" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "terminal" }, pane: "right" },
    )
    expect(context.layout.center.surface.kind).toBe("work")
    expect(context.layout.right.surface.kind).toBe("terminal")
  })

  it("remembers the selected git path when re-entering the git pane", () => {
    const context = snapshotAfter(
      { type: "CHAT_SELECTED", workspaceId: "workspace_1", chatId: "chat_1" },
      { type: "SURFACE_OPENED", target: { kind: "git" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "git", path: "src/app.ts" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "terminal" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "git" }, pane: "right" },
    )
    expect(context.layout.right.surface).toEqual({ kind: "git", path: "src/app.ts" })
  })

  it("keeps the git pane open when the center view changes", () => {
    const context = snapshotAfter(
      { type: "SURFACE_OPENED", target: { kind: "git" }, pane: "right" },
      { type: "SURFACE_OPENED", target: { kind: "work" }, pane: "center" },
    )
    expect(context.layout.center.surface.kind).toBe("work")
    expect(context.layout.right.surface.kind).toBe("git")
  })

  it("sets panel collapse explicitly without toggling", () => {
    const context = snapshotAfter(
      { type: "LEFT_PANEL_COLLAPSED_CHANGED", collapsed: true },
      { type: "RIGHT_PANEL_COLLAPSED_CHANGED", collapsed: true },
      { type: "LEFT_PANEL_COLLAPSED_CHANGED", collapsed: true },
    )
    expect(context.layout.left.collapsed).toBe(true)
    expect(context.layout.right.collapsed).toBe(true)
  })

  it("emits focusTerminal each time an attached session is focused", () => {
    const focus: ArcShellEvent = {
      type: "SESSION_FOCUSED",
      paneId: "pane_attached",
      session: attachedSession,
      workspaceId: "workspace_1",
    }
    const twice = snapshotAfter(focus, focus)

    // Re-focusing the already-active session still emits — a fresh event re-runs
    // the terminal's focus where an idempotent selection couldn't.
    expect(emittedAfter(focus)).toEqual(["focusTerminal"])
    expect(emittedAfter(focus, focus)).toEqual(["focusTerminal", "focusTerminal"])
    expect(twice.selection.terminalPaneId).toBe("pane_attached")
  })

  it("does not emit focusTerminal when focusing a detached session", () => {
    expect(
      emittedAfter({
        type: "SESSION_FOCUSED",
        paneId: "pane_unused",
        session: detachedSession,
        workspaceId: "workspace_2",
      }),
    ).toEqual([])
  })

  it("surfaces the chat and emits focusComposer on a ⌘L request", () => {
    const focus: ArcShellEvent = { type: "COMPOSER_FOCUS_REQUESTED" }
    // Start on the work view to prove ⌘L pulls the center back to chat (the
    // composer's home) before handing it focus.
    const once = snapshotAfter({ type: "SURFACE_OPENED", target: { kind: "work" }, pane: "center" }, focus)
    expect(once.layout.center.surface.kind).toBe("chat")
    expect(emittedAfter({ type: "SURFACE_OPENED", target: { kind: "work" }, pane: "center" }, focus)).toEqual(["focusComposer"])

    // Each press re-emits so the composer re-runs its focus even while already shown.
    expect(emittedAfter(focus, focus)).toEqual(["focusComposer", "focusComposer"])
  })

  it("surfaces the chat and emits scrollChatToBottom on a ⌘↓ request", () => {
    const jump: ArcShellEvent = { type: "CHAT_JUMP_TO_BOTTOM_REQUESTED" }
    const once = snapshotAfter({ type: "SURFACE_OPENED", target: { kind: "work" }, pane: "center" }, jump)
    expect(once.layout.center.surface.kind).toBe("chat")
    expect(emittedAfter({ type: "SURFACE_OPENED", target: { kind: "work" }, pane: "center" }, jump)).toEqual([
      "scrollChatToBottom",
    ])
  })

  it("focuses a detached session by showing the resume prompt without opening a pane", () => {
    const context = snapshotAfter({
      type: "SESSION_FOCUSED",
      paneId: "pane_unused",
      session: detachedSession,
      workspaceId: "workspace_2",
    })

    expect(context.detachedSessionId).toBe("target_detached")
    expect(context.panes).toEqual([])
    expect(context.selection.workspaceId).toBe("workspace_2")
    expect(context.selection.chatId).toBe("chat_2")
    expect(context.selection.sessionId).toBe("target_detached")
  })

  it("opens the terminal panel when focusing a detached session", () => {
    const context = snapshotAfter(
      { type: "RIGHT_PANEL_TOGGLED" },
      {
        type: "SESSION_FOCUSED",
        paneId: "pane_unused",
        session: detachedSession,
        workspaceId: "workspace_2",
      },
    )

    expect(context.layout.right.collapsed).toBe(false)
    expect(context.detachedSessionId).toBe("target_detached")
  })

  it("keeps detached focus after the sidebar emits its selection change", () => {
    const context = snapshotAfter(
      {
        type: "SESSION_FOCUSED",
        paneId: "pane_unused",
        session: detachedSession,
        workspaceId: "workspace_2",
      },
      {
        type: "SIDEBAR_SELECTION_CHANGED",
        selection: {
          workspaceId: "workspace_2",
          chatId: "chat_2",
          sessionId: "target_detached",
        },
      },
    )

    expect(context.detachedSessionId).toBe("target_detached")
    expect(context.selection.sessionId).toBe("target_detached")
  })

  it("closes the active pane on pty exit and activates the previous pane", () => {
    const context = snapshotAfter(
      {
        type: "TARGET_LAUNCH_REQUESTED",
        paneId: "pane_1",
        provider: "claude",
        chatId: "chat_1",
      },
      { type: "TARGET_BOUND", paneId: "pane_1", sessionId: "target_1" },
      {
        type: "TARGET_LAUNCH_REQUESTED",
        paneId: "pane_2",
        provider: "codex",
        chatId: "chat_1",
      },
      { type: "TARGET_BOUND", paneId: "pane_2", sessionId: "target_2" },
      { type: "PTY_EXITED", sessionId: "target_2" },
    )

    expect(context.selection.terminalPaneId).toBe("pane_1")
    expect(context.panes.map((pane) => pane.id)).toEqual(["pane_1"])
  })

  it("turns a detached resume request into a measuring resume pane", () => {
    const context = snapshotAfter({
      type: "DETACHED_RESUME_REQUESTED",
      paneId: "pane_resume",
      session: detachedSession,
      workspaceId: "workspace_2",
    })

    expect(context.detachedSessionId).toBeUndefined()
    expect(context.selection.terminalPaneId).toBe("pane_resume")
    expect(context.panes).toEqual([
      {
        id: "pane_resume",
        provider: "codex",
        chatId: "chat_2",
        sessionId: "target_detached",
        resumeSessionId: "target_detached",
      },
    ])
  })
})
