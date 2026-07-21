import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import type { TargetSession } from "../src/shared/instance.js"
import {
  arcShellMachine,
  initialArcShellContext,
  type ShellPane,
} from "../src/renderer/src/shell/arcShellMachine.js"
import { unadoptedSessions } from "../src/renderer/src/shell/sessionAdoption.js"
import { arcId, type PaneId, type TargetId } from "../src/shared/ids.js"

const session = (over: Partial<TargetSession> & { readonly id: TargetId }): TargetSession => ({
  _tag: "TargetSession",
  provider: "cursor",
  chatId: arcId("chat", "chat_a"),
  cwd: "/work",
  attached: true,
  state: "running",
  startedAt: "2026-06-14T00:00:00.000Z",
  ...over,
})

const pane = (over: Partial<ShellPane> & { readonly id: PaneId }): ShellPane => ({
  provider: "cursor",
  chatId: arcId("chat", "chat_a"),
  ...over,
})

describe("unadoptedSessions", () => {
  const orchestrated = (over: Partial<TargetSession> & { readonly id: TargetId }): TargetSession =>
    session({ origin: "orchestrated", ...over })

  it("adopts an attached orchestrated (out-of-band handoff) session with no pane", () => {
    const s = orchestrated({ id: arcId("target", "target_mcp") })
    expect(unadoptedSessions([s], [])).toEqual([s])
  })

  it("never adopts a manual session — a manual launch drives its own pane", () => {
    // The only time a manual session is attached-yet-paneless is the window right
    // after its PTY exits, when the arc:sessions snapshot still reads attached
    // (the exit event beats the state push). Adopting there re-opens a stray pane.
    const manual = session({ id: arcId("target", "target_manual"), origin: "manual" })
    const defaulted = session({ id: arcId("target", "target_default") }) // origin undefined → manual
    expect(unadoptedSessions([manual, defaulted], [])).toEqual([])
  })

  it("skips an orchestrated session already bound to a pane", () => {
    const s = orchestrated({ id: arcId("target", "target_bound") })
    const panes = [pane({ id: arcId("pane", "pane_1"), sessionId: arcId("target", "target_bound") })]
    expect(unadoptedSessions([s], panes)).toEqual([])
  })

  it("adopts an orchestrated session regardless of unrelated unbound panes", () => {
    const s = orchestrated({ id: arcId("target", "target_worker"), provider: "cursor" })
    const panes = [pane({ id: arcId("pane", "pane_2"), provider: "cursor", chatId: arcId("chat", "chat_a") })]
    expect(unadoptedSessions([s], panes)).toEqual([s])
  })

  it("skips detached and exited sessions (resume affordance, not a live pane)", () => {
    const detached = orchestrated({ id: arcId("target", "target_detached"), attached: false })
    const exited = orchestrated({ id: arcId("target", "target_exited"), state: "exited" })
    expect(unadoptedSessions([detached, exited], [])).toEqual([])
  })
})

describe("arcShellMachine TARGET_ADOPTED", () => {
  const adopt = (paneId: PaneId, id: TargetId, over?: Partial<ShellPane>) =>
    ({
      type: "TARGET_ADOPTED" as const,
      paneId,
      session: {
        id,
        provider: over?.provider ?? "cursor",
        chatId: over?.chatId ?? arcId("chat", "chat_a"),
        attached: true,
      },
    })

  it("mounts a pane and makes it active when the terminal region is empty", () => {
    const actor = createActor(arcShellMachine).start()
    actor.send(adopt(arcId("pane", "pane_1"), arcId("target", "target_mcp")))
    const { panes, selection } = actor.getSnapshot().context
    expect(panes).toEqual([
      { id: "pane_1", provider: "cursor", chatId: "chat_a", sessionId: "target_mcp" },
    ])
    expect(selection.terminalPaneId).toBe("pane_1")
  })

  it("does not grab focus or change the visible chat/surface", () => {
    const actor = createActor(arcShellMachine).start()
    // An out-of-band adoption must emit no focus signal — it must not yank the
    // keyboard out of whatever the user is doing.
    const emitted: Array<string> = []
    for (const type of ["focusComposer", "focusTerminal", "scrollChatToBottom"] as const) {
      actor.on(type, (event) => emitted.push(event.type))
    }
    actor.send(adopt(arcId("pane", "pane_1"), arcId("target", "target_mcp")))
    const ctx = actor.getSnapshot().context
    expect(emitted).toEqual([])
    expect(ctx.selection.chatId).toBeUndefined()
    expect(ctx.layout.right.surface).toEqual(initialArcShellContext.layout.right.surface)
    expect(ctx.layout.center).toEqual(initialArcShellContext.layout.center)
  })

  it("mounts later adoptions in the background without stealing the active pane", () => {
    const actor = createActor(arcShellMachine).start()
    actor.send(adopt(arcId("pane", "pane_1"), arcId("target", "target_first")))
    actor.send(adopt(arcId("pane", "pane_2"), arcId("target", "target_second")))
    const { panes, selection } = actor.getSnapshot().context
    expect(panes.map((p) => p.sessionId)).toEqual(["target_first", "target_second"])
    expect(selection.terminalPaneId).toBe("pane_1")
  })

  it("is idempotent: re-adopting a bound session is a no-op", () => {
    const actor = createActor(arcShellMachine).start()
    actor.send(adopt(arcId("pane", "pane_1"), arcId("target", "target_mcp")))
    actor.send(adopt(arcId("pane", "pane_2"), arcId("target", "target_mcp")))
    expect(actor.getSnapshot().context.panes).toHaveLength(1)
  })
})
