import { describe, expect, it } from "vitest"
import { arcMcpBearerToken } from "../src/shared/env-tags.js"
import {
  ARC_MCP_CHAT_HEADER,
  ARC_MCP_SESSION_HEADER,
  mergeProvenanceIds,
  provenanceFromBearerToken,
  provenanceFromEnv,
  provenanceFromHttpHeaders,
  provenanceToProxyHeaders,
} from "../src/main/mcp/provenance.js"

describe("MCP provenance headers", () => {
  it("maps env tags to proxy headers and back", () => {
    const prevSession = process.env["ARC_TARGET_SESSION_ID"]
    const prevChat = process.env["ARC_CHAT_ID"]
    process.env["ARC_TARGET_SESSION_ID"] = "target_abc"
    process.env["ARC_CHAT_ID"] = "chat_xyz"
    try {
      expect(provenanceToProxyHeaders(provenanceFromEnv())).toEqual({
        [ARC_MCP_SESSION_HEADER]: "target_abc",
        [ARC_MCP_CHAT_HEADER]: "chat_xyz",
      })
      expect(
        provenanceFromHttpHeaders({
          [ARC_MCP_SESSION_HEADER]: "target_abc",
          [ARC_MCP_CHAT_HEADER]: "chat_xyz",
        }),
      ).toEqual({ sessionId: "target_abc", chatId: "chat_xyz" })
    } finally {
      if (prevSession === undefined) delete process.env["ARC_TARGET_SESSION_ID"]
      else process.env["ARC_TARGET_SESSION_ID"] = prevSession
      if (prevChat === undefined) delete process.env["ARC_CHAT_ID"]
      else process.env["ARC_CHAT_ID"] = prevChat
    }
  })

  it("prefers transport headers over voluntary tool params", () => {
    expect(
      mergeProvenanceIds(
        { sessionId: "from-header", chatId: "from-header-chat" },
        { sessionId: "from-param", chatId: "from-param-chat" },
      ),
    ).toEqual({ sessionId: "from-header", chatId: "from-header-chat" })
    expect(mergeProvenanceIds({}, { sessionId: "from-param" })).toEqual({ sessionId: "from-param" })
  })

  it("round-trips arcMcpBearerToken through the bearer parser", () => {
    const token = arcMcpBearerToken({ targetSessionId: "target_abc", chatId: "chat_xyz" })
    expect(token).toBe("target_abc:chat_xyz")
    expect(provenanceFromBearerToken(`Bearer ${token}`)).toEqual({
      sessionId: "target_abc",
      chatId: "chat_xyz",
    })
  })

  it("ignores absent or non-Bearer authorization", () => {
    expect(provenanceFromBearerToken(undefined)).toEqual({})
    expect(provenanceFromBearerToken("Basic abc:xyz")).toEqual({})
    expect(provenanceFromBearerToken("Bearer ")).toEqual({})
  })

  it("derives provenance from a bearer token on the HTTP request", () => {
    expect(provenanceFromHttpHeaders({ authorization: "Bearer target_abc:chat_xyz" })).toEqual({
      sessionId: "target_abc",
      chatId: "chat_xyz",
    })
  })

  it("prefers proxy stamp headers over the bearer token", () => {
    expect(
      provenanceFromHttpHeaders({
        [ARC_MCP_SESSION_HEADER]: "from-proxy",
        authorization: "Bearer from-bearer:chat-bearer",
      }),
    ).toEqual({ sessionId: "from-proxy", chatId: "chat-bearer" })
  })
})

describe("Codex MCP TOML merge", () => {
  it("replaces an existing arc block and preserves other settings", async () => {
    const { mergeCodexMcpToml } = await import("../src/main/mcp/install.js")
    const merged = mergeCodexMcpToml(
      "model = \"gpt-5\"\n\n[mcp_servers.arc]\nurl = \"http://127.0.0.1:1/mcp\"\n",
    )
    expect(merged).toContain('model = "gpt-5"')
    expect(merged).toContain("[mcp_servers.arc]")
    expect(merged).toContain('url = "http://127.0.0.1:7793/mcp"')
    expect(merged).toContain('bearer_token_env_var = "ARC_MCP_TOKEN"')
    expect(merged).not.toContain("127.0.0.1:1")
  })

  it("strips the stale experimental_use_rmcp_client flag when migrating from the old proxy config", async () => {
    const { mergeCodexMcpToml } = await import("../src/main/mcp/install.js")
    const merged = mergeCodexMcpToml(
      "experimental_use_rmcp_client = true\n\n[mcp_servers.arc]\ncommand = \"arc-work\"\nargs = [\"mcp-proxy\"]\n",
    )
    expect(merged).not.toContain("experimental_use_rmcp_client")
    expect(merged).not.toContain("mcp-proxy")
    expect(merged).toContain('bearer_token_env_var = "ARC_MCP_TOKEN"')
  })
})
