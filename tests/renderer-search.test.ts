import { describe, expect, it } from "vitest"
import type { ArcEntity, ArcSearchHit } from "../src/shared/read.js"
import {
  buildArcSearchParams,
  labelForSearchHit,
  subtitleForSearchHit,
  targetFromSearchHit,
  workspaceIdForSearchTarget,
} from "../src/renderer/src/search/arcSearchModel.js"

const baseHit = (overrides: Partial<ArcSearchHit>): ArcSearchHit => ({
  ref: "work_1",
  kind: "work",
  title: "Search result",
  preview: "Preview",
  updatedAt: "2026-06-17T00:00:00.000Z",
  score: null,
  ...overrides,
})

describe("renderer arc search model", () => {
  it("builds structured search params with kind filters and current chat scope", () => {
    expect(
      buildArcSearchParams({
        query: "  auth bug  ",
        kinds: new Set(["work", "chat", "message"]),
        scope: "currentChat",
        currentChatId: "chat_1",
      }),
    ).toEqual({
      query: "auth bug",
      kinds: ["work", "chat", "message"],
      filters: { chatId: "chat_1" },
      limit: 12,
    })

    expect(
      buildArcSearchParams(
        { query: "", kinds: new Set(["work"]), scope: "all", currentChatId: "chat_1" },
        "cursor_2",
      ),
    ).toEqual({ kinds: ["work"], limit: 12, cursor: "cursor_2" })
  })

  it("renders the rigid hit envelope with useful message metadata", () => {
    const hit = baseHit({
      ref: "message_1",
      kind: "message",
      score: 4,
      message: {
        chatId: "chat_1",
        role: "assistant",
        rowKind: "tool",
        toolName: "mcp__arc__arc_search",
        status: "pending",
        ordinal: 2,
        occurredAt: "2026-06-17T00:00:00.000Z",
      },
    })

    expect(labelForSearchHit(hit)).toBe("tool:mcp__arc__arc_search")
    expect(subtitleForSearchHit(hit)).toBe("#3 · pending")
  })

  it("maps hydrated selected results to existing navigation targets", () => {
    const workEntity = {
      _tag: "work",
      work: { id: "work_1" },
      comments: [],
      olderRevisionCommentCount: 0,
    } as unknown as ArcEntity
    const chatEntity = {
      _tag: "chat",
      chat: { id: "chat_1", workspaceId: "workspace_1" },
    } as unknown as ArcEntity
    const messageEntity = {
      _tag: "message",
      message: { id: "message_1", chatId: "chat_2" },
    } as unknown as ArcEntity

    expect(targetFromSearchHit(baseHit({ ref: "work_1" }), [workEntity])).toEqual({
      kind: "work",
      workId: "work_1",
    })
    expect(targetFromSearchHit(baseHit({ ref: "chat_1", kind: "chat" }), [chatEntity])).toEqual({
      kind: "chat",
      chatId: "chat_1",
    })
    expect(targetFromSearchHit(baseHit({ ref: "message_1", kind: "message" }), [messageEntity])).toEqual({
      kind: "message",
      chatId: "chat_2",
    })
  })

  it("falls back to message hit metadata when hydration returns no entity", () => {
    const hit = baseHit({
      ref: "message_1",
      kind: "message",
      message: {
        chatId: "chat_1",
        role: "user",
        rowKind: "message",
        ordinal: 0,
        occurredAt: "2026-06-17T00:00:00.000Z",
      },
    })

    expect(targetFromSearchHit(hit, [])).toEqual({ kind: "message", chatId: "chat_1" })
    expect(
      workspaceIdForSearchTarget(
        [{ id: "chat_1", workspaceId: "workspace_1", title: "Chat" } as never],
        { kind: "message", chatId: "chat_1" },
      ),
    ).toBe("workspace_1")
  })
})
