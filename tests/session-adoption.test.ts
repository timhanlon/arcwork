import { describe, expect, it } from "vitest"
import { createActor } from "xstate"
import type { TargetSession } from "../src/shared/instance.js"
import {
  arcShellMachine,
  initialArcShellContext,
  type ShellPane,
} from "../src/renderer/src/shell/arcShellMachine.js"
import { unadoptedSessions } from "../src/renderer/src/shell/sessionAdoption.js"

const session = (over: Partial<TargetSession> & { readonly id: string }): TargetSession => ({
  _tag: "TargetSession",
  provider: "cursor",
  chatId: "chat_a",
  cwd: "/work",
  attached: true,
  state: "running",
  startedAt: "2026-06-14T00:00:00.000Z",
  ...over,
})

const pane = (over: Partial<ShellPane> & { readonly id: string }): ShellPane => ({
  provider: "cursor",
  chatId: "chat_a",
  ...over,
})

describe("unadoptedSessions", () => {
  it("adopts an attached session with no pane (an MCP/handoff launch)", () => {
    const s = session({ id: "target_mcp" })
    expect(unadoptedSessions([s], [])).toEqual([s])
  })

  it("skips a session already bound to a pane", () => {
    const s = session({ id: "target_bound" })
    const panes = [pane({ id: "pane_1", sessionId: "target_bound" })]
    expect(unadoptedSessions([s], panes)).toEqual([])
  })

  it("skips a manual launch mid-bind: an unbound pane for the same (provider, chat)", () => {
    // The session is broadcast the instant launch writes the store, which can
    // beat the launch rpc binding its pane — the pane is still unbound here.
    const s = session({ id: "target_manual", provider: "claude" })
    const panes = [pane({ id: "pane_2", provider: "claude", chatId: "chat_a" })]
    expect(unadoptedSessions([s], panes)).toEqual([])
  })

  it("still adopts when an unbound pane is for a different (provider, chat)", () => {
    const s = session({ id: "target_mcp", provider: "cursor", chatId: "chat_a" })
    const panes = [pane({ id: "pane_3", provider: "claude", chatId: "chat_b" })]
    expect(unadoptedSessions([s], panes)).toEqual([s])
  })

  it("skips detached and exited sessions (resume affordance, not a live pane)", () => {
    const detached = session({ id: "target_detached", attached: false })
    const exited = session({ id: "target_exited", state: "exited" })
    expect(unadoptedSessions([detached, exited], [])).toEqual([])
  })
})

describe("arcShellMachine TARGET_ADOPTED", () => {
  const adopt = (paneId: string, id: string, over?: Partial<ShellPane>) =>
    ({
      type: "TARGET_ADOPTED" as const,
      paneId,
      session: {
        id,
        provider: over?.provider ?? "cursor",
        chatId: over?.chatId ?? "chat_a",
        attached: true,
      },
    })

  it("mounts a pane and makes it active when the terminal region is empty", () => {
    const actor = createActor(arcShellMachine).start()
    actor.send(adopt("pane_1", "target_mcp"))
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
    actor.send(adopt("pane_1", "target_mcp"))
    const ctx = actor.getSnapshot().context
    expect(emitted).toEqual([])
    expect(ctx.selection.chatId).toBeUndefined()
    expect(ctx.layout.right.surface).toEqual(initialArcShellContext.layout.right.surface)
    expect(ctx.layout.center.surface).toEqual(initialArcShellContext.layout.center.surface)
  })

  it("mounts later adoptions in the background without stealing the active pane", () => {
    const actor = createActor(arcShellMachine).start()
    actor.send(adopt("pane_1", "target_first"))
    actor.send(adopt("pane_2", "target_second"))
    const { panes, selection } = actor.getSnapshot().context
    expect(panes.map((p) => p.sessionId)).toEqual(["target_first", "target_second"])
    expect(selection.terminalPaneId).toBe("pane_1")
  })

  it("is idempotent: re-adopting a bound session is a no-op", () => {
    const actor = createActor(arcShellMachine).start()
    actor.send(adopt("pane_1", "target_mcp"))
    actor.send(adopt("pane_2", "target_mcp"))
    expect(actor.getSnapshot().context.panes).toHaveLength(1)
  })
})
