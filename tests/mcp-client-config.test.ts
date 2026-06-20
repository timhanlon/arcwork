import { join } from "node:path"
import { describe, expect, it } from "vitest"
import {
  MCP_PROVIDERS,
  isMcpProvider,
  mergeArcServer,
  providerClientConfig,
  providerMcpLaunchArgs,
  providerServerEntry,
} from "../src/main/mcp/client-config.js"

const URL = "http://127.0.0.1:7793/mcp"

describe("MCP client config (per-provider, HTTP bearer)", () => {
  it("declares an HTTP bearer server for claude/cursor", () => {
    // claude needs an explicit transport tag and expands ${VAR} in headers.
    expect(providerServerEntry("claude")).toEqual({
      type: "http",
      url: URL,
      headers: { Authorization: "Bearer ${ARC_MCP_TOKEN}" },
    })
    // cursor infers HTTP from `url` and expands ${env:VAR} in headers.
    expect(providerServerEntry("cursor")).toEqual({
      url: URL,
      headers: { Authorization: "Bearer ${env:ARC_MCP_TOKEN}" },
    })
  })

  it("scopes config files: claude/cursor project-local, codex user-level", () => {
    const cwd = "/work/repo"
    const home = "/home/dev"
    expect(providerClientConfig("claude", cwd, home)).toMatchObject({
      file: join(cwd, ".mcp.json"),
      writable: true,
    })
    expect(providerClientConfig("cursor", cwd, home)).toMatchObject({
      file: join(cwd, ".cursor", "mcp.json"),
      writable: true,
    })
    expect(providerClientConfig("codex", cwd, home)).toMatchObject({
      file: join(home, ".codex", "config.toml"),
      writable: true,
    })
  })

  it("renders claude config as valid JSON carrying the HTTP bearer server", () => {
    const doc = providerClientConfig("claude", "/c", "/h").render()
    expect(JSON.parse(doc)).toEqual({
      mcpServers: {
        arc: {
          type: "http",
          url: URL,
          headers: { Authorization: "Bearer ${ARC_MCP_TOKEN}" },
        },
      },
    })
  })

  it("renders codex config as a streamable-HTTP bearer TOML block", () => {
    const doc = providerClientConfig("codex", "/c", "/h").render()
    expect(doc).toContain("[mcp_servers.arc]")
    expect(doc).toContain(`url = "${URL}"`)
    expect(doc).toContain('bearer_token_env_var = "ARC_MCP_TOKEN"')
    expect(doc).not.toContain("experimental_use_rmcp_client")
    expect(doc).not.toContain("mcp-proxy")
  })

  it("merges arc into existing config without disturbing other servers or keys", () => {
    const existing = {
      $schema: "https://example/schema.json",
      mcpServers: { other: { command: "foo", args: ["bar"] } },
    }
    const merged = mergeArcServer(existing, "cursor")
    expect(merged).toEqual({
      $schema: "https://example/schema.json",
      mcpServers: {
        other: { command: "foo", args: ["bar"] },
        arc: { url: URL, headers: { Authorization: "Bearer ${env:ARC_MCP_TOKEN}" } },
      },
    })
    // Pure: the input object is not mutated.
    expect(existing.mcpServers).not.toHaveProperty("arc")
  })

  it("merging overwrites a stale stdio-proxy arc entry with the HTTP bearer server", () => {
    const stale = {
      mcpServers: { arc: { type: "stdio", command: "arc-work", args: ["mcp-proxy"] } },
    }
    const merged = mergeArcServer(stale, "claude")
    expect(merged.mcpServers).toEqual({
      arc: { type: "http", url: URL, headers: { Authorization: "Bearer ${ARC_MCP_TOKEN}" } },
    })
  })

  it("isMcpProvider guards the known set", () => {
    for (const p of MCP_PROVIDERS) expect(isMcpProvider(p)).toBe(true)
    expect(isMcpProvider("gemini")).toBe(false)
  })
})

describe("repo-clean MCP launch args", () => {
  it("claude declares the arc server inline as a --mcp-config JSON string", () => {
    const args = providerMcpLaunchArgs("claude")
    expect(args[0]).toBe("--mcp-config")
    expect(JSON.parse(args[1]!)).toEqual({
      mcpServers: {
        arc: { type: "http", url: URL, headers: { Authorization: "Bearer ${ARC_MCP_TOKEN}" } },
      },
    })
    // no file path, no repo mention — it's a literal config payload
    expect(args.join(" ")).not.toContain(".mcp.json")
  })

  it("codex overrides nested config inline with -c (no file touched)", () => {
    expect(providerMcpLaunchArgs("codex")).toEqual([
      "-c",
      `mcp_servers.arc.url="${URL}"`,
      "-c",
      `mcp_servers.arc.bearer_token_env_var="ARC_MCP_TOKEN"`,
    ])
  })

  it("cursor only needs --approve-mcps (server lives in the plugin's mcp.json)", () => {
    expect(providerMcpLaunchArgs("cursor")).toEqual(["--approve-mcps"])
  })
})
