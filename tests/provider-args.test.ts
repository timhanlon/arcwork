import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest"
import type { TargetSession } from "../src/shared/instance.js"
import { arcId } from "../src/shared/ids.js"
import {
  buildProviderArgs,
  canResume,
  inferredTranscriptPath,
  resumeArgs,
} from "../src/main/services/target-session/provider-args.js"
import { installCursorHooks, installCursorPlugin, cursorPluginLaunchArgs } from "../src/main/hooks/cursor-plugin.js"
import { installPiExtension, piLaunchArgs } from "../src/main/hooks/pi-connector.js"
import { isMcpProvider, providerMcpLaunchArgs } from "../src/main/mcp/client-config.js"

// provider-args owns the per-provider launch/resume argv decisions, split out of
// the manager so the branching is unit-testable. The pure helpers (resumeArgs /
// transcript-path inference / canResume) need no mocks; buildProviderArgs stubs
// the install/launch-arg seams to assert the cursor/pi/mcp branches and the
// best-effort fallthrough (install fails → [] rather than throwing).

vi.mock("../src/main/hooks/cursor-plugin.js", () => ({
  installCursorPlugin: vi.fn(),
  installCursorHooks: vi.fn(),
  cursorPluginLaunchArgs: vi.fn(),
}))
vi.mock("../src/main/hooks/pi-connector.js", () => ({
  installPiExtension: vi.fn(),
  piLaunchArgs: vi.fn(),
}))
vi.mock("../src/main/mcp/client-config.js", () => ({
  isMcpProvider: vi.fn(),
  providerMcpLaunchArgs: vi.fn(),
}))

const ctx = { chatId: "chat_test", targetSessionId: "target_test", cwd: "/tmp/arc-test" }

const sessionOf = (s: Partial<TargetSession>): TargetSession => ({
  _tag: "TargetSession",
  id: arcId("target", "target_test"),
  provider: "claude",
  origin: "manual",
  chatId: arcId("chat", "chat_test"),
  cwd: "/tmp/arc-test",
  attached: false,
  state: "unknown",
  startedAt: "2026-01-01T00:00:00.000Z",
  ...s,
})

describe("resumeArgs", () => {
  it("maps each provider's resume invocation", () => {
    expect(resumeArgs("claude", "abc")).toEqual(["--resume", "abc"])
    expect(resumeArgs("codex", "abc")).toEqual(["resume", "abc"])
    expect(resumeArgs("cursor", "abc")).toEqual(["--resume", "abc"])
    expect(resumeArgs("pi", "abc")).toEqual(["--session", "abc"])
  })

  it("returns null with no native session id, or an unknown provider", () => {
    expect(resumeArgs("claude", undefined)).toBeNull()
    expect(resumeArgs("mystery", "abc")).toBeNull()
  })
})

describe("inferredTranscriptPath", () => {
  it("derives the claude transcript path from the cwd slug + native session id", () => {
    const expected = path.join(
      os.homedir(),
      ".claude",
      "projects",
      "-Users-t-dev-aux",
      "S1.jsonl",
    )
    expect(
      inferredTranscriptPath(sessionOf({ provider: "claude", cwd: "/Users/t/dev/aux", nativeSessionId: "S1" })),
    ).toBe(expected)
  })

  it("prefers an explicit native transcript path", () => {
    expect(
      inferredTranscriptPath(
        sessionOf({ provider: "claude", nativeSessionId: "S1", nativeTranscriptPath: "/explicit/x.jsonl" }),
      ),
    ).toBe("/explicit/x.jsonl")
  })

  it("is undefined without a native session id, or for a non-claude provider", () => {
    expect(inferredTranscriptPath(sessionOf({ provider: "claude", nativeSessionId: undefined }))).toBeUndefined()
    expect(inferredTranscriptPath(sessionOf({ provider: "codex", nativeSessionId: "S1" }))).toBeUndefined()
  })
})

describe("canResume", () => {
  it("is false without a native session id", () => {
    expect(canResume(sessionOf({ nativeSessionId: undefined }))).toBe(false)
  })

  it("is true for a non-claude provider that has a native session id (no transcript file needed)", () => {
    expect(canResume(sessionOf({ provider: "codex", nativeSessionId: "S1" }))).toBe(true)
  })

  it("requires the transcript file to exist for claude", () => {
    const file = path.join(os.tmpdir(), `arc-canresume-${process.pid}.jsonl`)
    fs.writeFileSync(file, "{}")
    try {
      expect(canResume(sessionOf({ provider: "claude", nativeSessionId: "S1", nativeTranscriptPath: file }))).toBe(true)
      fs.rmSync(file)
      expect(canResume(sessionOf({ provider: "claude", nativeSessionId: "S1", nativeTranscriptPath: file }))).toBe(false)
    } finally {
      if (fs.existsSync(file)) fs.rmSync(file)
    }
  })
})

describe("buildProviderArgs", () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })
  afterAll(() => {
    vi.restoreAllMocks()
  })

  it("installs the cursor plugin + hooks and returns its launch args", async () => {
    vi.mocked(installCursorPlugin).mockReturnValue({ installed: true, dir: "/plug" } as never)
    vi.mocked(installCursorHooks).mockReturnValue({ installed: true } as never)
    vi.mocked(cursorPluginLaunchArgs).mockReturnValue(["--plugin-dir", "/plug"] as never)

    const args = await Effect.runPromise(buildProviderArgs("cursor", ctx))

    expect(args).toEqual(["--plugin-dir", "/plug"])
    expect(installCursorPlugin).toHaveBeenCalledWith(expect.objectContaining({ scopeId: ctx.targetSessionId }))
  })

  it("falls through to no args when the cursor plugin install fails", async () => {
    vi.mocked(installCursorPlugin).mockReturnValue({ installed: false, reason: "boom" } as never)

    const args = await Effect.runPromise(buildProviderArgs("cursor", ctx))

    expect(args).toEqual([])
    expect(cursorPluginLaunchArgs).not.toHaveBeenCalled()
  })

  it("installs the pi extension and returns its launch args", async () => {
    vi.mocked(installPiExtension).mockReturnValue({ installed: true, file: "/ext.ts" } as never)
    vi.mocked(piLaunchArgs).mockReturnValue(["-e", "/ext.ts"] as never)

    const args = await Effect.runPromise(buildProviderArgs("pi", ctx))

    expect(args).toEqual(["-e", "/ext.ts"])
  })

  it("falls through to no args when the pi extension install fails", async () => {
    vi.mocked(installPiExtension).mockReturnValue({ installed: false, reason: "nope" } as never)

    const args = await Effect.runPromise(buildProviderArgs("pi", ctx))

    expect(args).toEqual([])
  })

  it("returns inline MCP args for an mcp provider", async () => {
    vi.mocked(isMcpProvider).mockReturnValue(true)
    vi.mocked(providerMcpLaunchArgs).mockReturnValue(["--mcp-config", "x"] as never)

    const args = await Effect.runPromise(buildProviderArgs("claude", ctx))

    expect(args).toEqual(["--mcp-config", "x"])
  })

  it("returns no args for a non-mcp, non-integration provider", async () => {
    vi.mocked(isMcpProvider).mockReturnValue(false)

    const args = await Effect.runPromise(buildProviderArgs("plain", ctx))

    expect(args).toEqual([])
  })
})
