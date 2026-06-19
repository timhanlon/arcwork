import { describe, expect, it } from "vitest"
import { ArcEnvTags, arcEnvTags, arcMcpBearerToken } from "../src/shared/env-tags.js"

describe("arcEnvTags", () => {
  it("stamps target identity without a DB path by default", () => {
    expect(
      arcEnvTags({
        chatId: "chat_123",
        targetSessionId: "target_123",
        provider: "codex",
      }),
    ).toEqual({
      [ArcEnvTags.chatId]: "chat_123",
      [ArcEnvTags.targetSessionId]: "target_123",
      [ArcEnvTags.targetProvider]: "codex",
      [ArcEnvTags.mcpToken]: arcMcpBearerToken({ chatId: "chat_123", targetSessionId: "target_123" }),
    })
  })

  it("includes ARC_DB_PATH when the launcher supplies the resolved store path", () => {
    expect(
      arcEnvTags({
        chatId: "chat_123",
        targetSessionId: "target_123",
        provider: "codex",
        dbPath: "/tmp/arc/state/arc.sqlite",
      }),
    ).toMatchObject({
      [ArcEnvTags.dbPath]: "/tmp/arc/state/arc.sqlite",
    })
  })
})
