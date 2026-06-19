import { describe, expect, it } from "vitest"
import { orderedPendingSessionIds } from "../src/renderer/src/sidebar/grouping.js"
import { chat, session, workspace } from "../src/renderer/src/sidebar/fixtures.js"

// ⌘1…⌘9 index into this list, so its order must match the sidebar's paint order:
// workspaces as given, chats newest-first, sessions in arrival order. Only
// waiting sessions appear, so the hint number on a row equals the key that
// focuses it.
describe("orderedPendingSessionIds", () => {
  const ws1 = workspace({ id: "ws_1" })
  const ws2 = workspace({ id: "ws_2" })
  // Two chats in ws_1; the later createdAt sorts first (newest-first).
  const older = chat({ id: "chat_old", workspaceId: "ws_1", title: "old", createdAt: "2026-06-01T00:00:00.000Z" })
  const newer = chat({ id: "chat_new", workspaceId: "ws_1", title: "new", createdAt: "2026-06-05T00:00:00.000Z" })
  const otherWs = chat({ id: "chat_w2", workspaceId: "ws_2", title: "w2" })

  it("returns waiting sessions in tree order: workspace, newest chat, arrival", () => {
    const sessions = [
      session({ id: "s_old_a", chatId: "chat_old", provider: "claude" }),
      session({ id: "s_new_a", chatId: "chat_new", provider: "claude" }),
      session({ id: "s_new_b", chatId: "chat_new", provider: "codex" }),
      session({ id: "s_w2", chatId: "chat_w2", provider: "claude" }),
    ]
    const pending = new Set(["s_old_a", "s_new_a", "s_new_b", "s_w2"])
    const ordered = orderedPendingSessionIds([ws1, ws2], [older, newer, otherWs], sessions, pending)
    // newer chat before older within ws_1; ws_1 entirely before ws_2.
    expect(ordered).toEqual(["s_new_a", "s_new_b", "s_old_a", "s_w2"])
  })

  it("excludes sessions that are not waiting", () => {
    const sessions = [
      session({ id: "s_a", chatId: "chat_new", provider: "claude" }),
      session({ id: "s_b", chatId: "chat_new", provider: "codex" }),
    ]
    const ordered = orderedPendingSessionIds([ws1], [newer], sessions, new Set(["s_b"]))
    expect(ordered).toEqual(["s_b"])
  })

  it("is empty when nothing is waiting", () => {
    const sessions = [session({ id: "s_a", chatId: "chat_new", provider: "claude" })]
    expect(orderedPendingSessionIds([ws1], [newer], sessions, new Set())).toEqual([])
  })
})
