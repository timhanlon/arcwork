import { Result } from "effect"
import { describe, expect, it } from "vitest"
import {
  agentEventDedupKey,
  classifyApplyPatchPaths,
  hookSignalToActivityDrafts,
  hookSignalToAgentEvents,
  redactValue,
} from "../src/main/hooks/agent-event.js"
import { hookSignalToChatMessageDrafts } from "../src/main/hooks/chat-message.js"
import { toBinding, toSignal } from "../src/main/hooks/signals.js"

const wire = (body: Record<string, unknown>): string => JSON.stringify(body)

const parseSignal = (body: Record<string, unknown>) =>
  Result.getOrThrow(toSignal(wire(body)))

describe("HookSignal envelope", () => {
  it("parses versioned wire records with native extraction", () => {
    const signal = parseSignal({
      schemaVersion: 1,
      helperVersion: 1,
      declaredProvider: "codex",
      declaredEvent: "SessionStart",
      observedAt: "2026-06-04T12:00:00.000Z",
      cwd: "/tmp/repo",
      pid: 1234,
      argv: ["node", "arc-hook-signal.mjs", "codex", "SessionStart"],
      hookInputParseOk: true,
      hookInputSha256: "abc123",
      hookInput: {
        session_id: "sess-1",
        transcript_path: "/Users/test/.codex/rollouts/r.jsonl",
        model: "gpt-5",
      },
      native: {
        sessionId: "sess-1",
        transcriptPath: "/Users/test/.codex/rollouts/r.jsonl",
        model: "gpt-5",
      },
      arc: {
        chatId: "chat_01",
        targetSessionId: "target_01",
        targetProvider: "codex",
        hookSockPresent: true,
      },
    })

    expect(signal.provider).toBe("codex")
    expect(signal.native.sessionId).toBe("sess-1")
    expect(signal.hookInputSha256).toBe("abc123")
    expect(signal.arc.hookSockPresent).toBe(true)
  })

  it("still parses legacy flat wire records", () => {
    const signal = parseSignal({
      provider: "claude",
      event: "SessionStart",
      at: "2026-06-04T12:00:00.000Z",
      cwd: "/tmp/repo",
      argv: [],
      hookInput: { session_id: "legacy-sess", transcript_path: "/tmp/t.jsonl" },
      sessionId: "legacy-sess",
      arcTargetSessionId: "target_01",
      arcTargetProvider: "claude",
    })

    expect(signal.declaredProvider).toBe("claude")
    expect(signal.sessionId).toBe("legacy-sess")
  })
})

describe("Provider resolution + binding", () => {
  // Regression: codex mirrors Claude's hook schema (it emits permission_mode,
  // source, hook_event_name). Before the fix, isClaudeHookPayload matched on
  // permission_mode ahead of the /.codex/ path check, so codex SessionStart
  // resolved to "claude", toBinding rejected it as a provider mismatch, and the
  // native session id was never bound — leaving past codex sessions unresumable.
  const codexSessionStart = (): Record<string, unknown> => ({
    declaredProvider: "codex",
    declaredEvent: "SessionStart",
    observedAt: "2026-06-04T12:00:00.000Z",
    hookInputSha256: "codex-claude-shaped",
    hookInput: {
      session_id: "019e93f7-fb12-7b82-b6a1-fc620bf400ab",
      transcript_path:
        "/Users/test/.codex/sessions/2026/06/05/rollout-2026-06-05T04-49-22-019e93f7-fb12-7b82-b6a1-fc620bf400ab.jsonl",
      hook_event_name: "SessionStart",
      model: "gpt-5.5",
      permission_mode: "default",
      source: "startup",
    },
    arc: {
      chatId: "chat_01",
      targetSessionId: "target_01",
      targetProvider: "codex",
      hookSockPresent: true,
    },
  })

  it("resolves a claude-shaped codex payload (permission_mode under /.codex/) to codex", () => {
    expect(parseSignal(codexSessionStart()).provider).toBe("codex")
  })

  it("binds the native session id instead of rejecting it as a provider mismatch", () => {
    const result = toBinding(wire(codexSessionStart()))
    expect(Result.isSuccess(result)).toBe(true)
    if (Result.isFailure(result)) return
    expect(result.success.provider).toBe("codex")
    expect(result.success.targetSessionId).toBe("target_01")
    expect(result.success.nativeSessionId).toBe("019e93f7-fb12-7b82-b6a1-fc620bf400ab")
  })
})

describe("Codex hook mappings", () => {
  it("maps SessionStart to session_start (+ model_update when model present)", () => {
    const signal = parseSignal({
      declaredProvider: "codex",
      declaredEvent: "SessionStart",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "codex-ss",
      hookInput: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        transcript_path: "/Users/test/.codex/rollouts/r.jsonl",
        hook_event_name: "SessionStart",
        model: "gpt-4.1",
      },
    })

    const events = hookSignalToAgentEvents(signal)
    expect(events.map((e) => e.type)).toEqual(["session_start", "model_update"])
    expect(events[0]?.sessionId).toBe("550e8400-e29b-41d4-a716-446655440000")
  })

  it("maps PostToolUse apply_patch to tool_use with file buckets", () => {
    const signal = parseSignal({
      declaredProvider: "codex",
      declaredEvent: "PostToolUse",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "codex-ptu",
      hookInput: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        cwd: "/tmp/testrepo",
        tool_name: "apply_patch",
        tool_use_id: "call-abc",
        tool_input: {
          command:
            "*** Begin Patch\n*** Add File: a.txt\n+hi\n*** Update File: b.txt\n@@\n-old\n+new\n*** Delete File: c.txt\n*** End Patch\n",
        },
      },
    })

    const events = hookSignalToAgentEvents(signal)
    expect(events).toHaveLength(1)
    expect(events[0]?.type).toBe("tool_use")
    expect(events[0]?.newFiles).toEqual(["a.txt"])
    expect(events[0]?.modifiedFiles).toEqual(["b.txt"])
    expect(events[0]?.deletedFiles).toEqual(["c.txt"])

    const drafts = hookSignalToActivityDrafts(signal)
    expect(drafts.some((d) => d.kind === "target.tool.used")).toBe(true)
    expect(drafts.filter((d) => d.kind === "file.observed")).toHaveLength(3)
  })

  it("accepts Write and Edit aliases for apply_patch", () => {
    for (const toolName of ["Write", "Edit"] as const) {
      const signal = parseSignal({
        declaredProvider: "codex",
        declaredEvent: "PostToolUse",
        observedAt: "2026-06-04T12:00:00.000Z",
        hookInputSha256: `codex-${toolName}`,
        hookInput: {
          session_id: "s",
          cwd: "/tmp/r",
          tool_name: toolName,
          tool_input: {
            command: "*** Begin Patch\n*** Add File: x.txt\n+x\n*** End Patch\n",
          },
        },
      })
      const events = hookSignalToAgentEvents(signal)
      expect(events[0]?.newFiles).toEqual(["x.txt"])
    }
  })

  // Unified-vocabulary coverage: the old per-provider triplet had no codex
  // SessionEnd arm, so codex session ends silently dropped. The canonical
  // dispatcher maps every provider's SessionEnd → session_end consistently.
  it("maps SessionEnd to session_end", () => {
    const signal = parseSignal({
      declaredProvider: "codex",
      declaredEvent: "SessionEnd",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "codex-se",
      hookInput: {
        session_id: "550e8400-e29b-41d4-a716-446655440000",
        transcript_path: "/Users/test/.codex/rollouts/r.jsonl",
        hook_event_name: "SessionEnd",
      },
    })
    expect(hookSignalToAgentEvents(signal).map((e) => e.type)).toEqual(["session_end"])
  })
})

describe("Claude hook mappings", () => {
  it("maps lifecycle hooks to normalized agent events", () => {
    const sessionStart = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "SessionStart",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-ss",
      hookInput: {
        session_id: "test-session-123",
        transcript_path: "/tmp/transcript.jsonl",
        permission_mode: "default",
        model: "claude-sonnet-4-20250514",
      },
    })
    expect(hookSignalToAgentEvents(sessionStart).map((e) => e.type)).toEqual([
      "session_start",
      "model_update",
    ])

    const turnStart = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "UserPromptSubmit",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-ups",
      hookInput: {
        session_id: "sess-456",
        transcript_path: "/tmp/t.jsonl",
        permission_mode: "default",
        prompt: "Hello world",
      },
    })
    const turnEvents = hookSignalToAgentEvents(turnStart)
    expect(turnEvents).toHaveLength(1)
    expect(turnEvents[0]?.type).toBe("turn_start")
    expect(turnEvents[0]?.prompt).toBe("Hello world")

    const stop = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "Stop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-stop",
      hookInput: {
        session_id: "sess-789",
        transcript_path: "/tmp/stop.jsonl",
        permission_mode: "default",
      },
    })
    expect(hookSignalToAgentEvents(stop)[0]?.type).toBe("turn_end")
  })

  it("maps subagent boundaries", () => {
    const start = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "SubagentStart",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-sub-start",
      hookInput: {
        session_id: "sess-sub",
        permission_mode: "default",
        tool_use_id: "tool-1",
      },
    })
    expect(hookSignalToAgentEvents(start)[0]?.type).toBe("subagent_start")

    const stop = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "SubagentStop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-sub-stop",
      hookInput: {
        session_id: "sess-sub",
        permission_mode: "default",
        tool_use_id: "tool-1",
        agent_id: "agent-9",
      },
    })
    const end = hookSignalToAgentEvents(stop)[0]
    expect(end?.type).toBe("subagent_end")
    expect(end?.subagentId).toBe("agent-9")
  })
})

describe("Cursor hook mappings", () => {
  it("maps session and turn hooks using conversation_id", () => {
    const sessionStart = parseSignal({
      declaredProvider: "cursor",
      declaredEvent: "sessionStart",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-ss",
      hookInput: {
        conversation_id: "test-session-123",
        transcript_path: "/tmp/transcript.jsonl",
        cursor_version: "1.0.0",
      },
    })
    expect(hookSignalToAgentEvents(sessionStart)[0]?.sessionId).toBe("test-session-123")

    const turnStart = parseSignal({
      declaredProvider: "cursor",
      declaredEvent: "beforeSubmitPrompt",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-turn",
      hookInput: {
        conversation_id: "sess-456",
        transcript_path: "/tmp/t.jsonl",
        prompt: "Hello world",
        cursor_version: "1.0.0",
      },
    })
    const event = hookSignalToAgentEvents(turnStart)[0]
    expect(event?.type).toBe("turn_start")
    expect(event?.prompt).toBe("Hello world")
  })

  it("maps subagentStop with modified file lists", () => {
    const signal = parseSignal({
      declaredProvider: "cursor",
      declaredEvent: "subagentStop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-sub-stop",
      hookInput: {
        conversation_id: "conv-1",
        task: "Review files",
        subagent_id: "sub-1",
        modified_files: ["src/a.ts", "src/b.ts"],
        cursor_version: "1.0.0",
      },
    })

    const event = hookSignalToAgentEvents(signal)[0]
    expect(event?.type).toBe("subagent_end")
    expect(event?.modifiedFiles).toEqual(["src/a.ts", "src/b.ts"])

    const drafts = hookSignalToActivityDrafts(signal)
    expect(drafts.filter((d) => d.kind === "file.observed")).toHaveLength(2)
  })

  it("maps afterFileEdit to tool_use", () => {
    const signal = parseSignal({
      declaredProvider: "cursor",
      declaredEvent: "afterFileEdit",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-edit",
      hookInput: {
        conversation_id: "conv-edit",
        file_path: "src/main.ts",
        cursor_version: "1.0.0",
      },
    })
    const event = hookSignalToAgentEvents(signal)[0]
    expect(event?.type).toBe("tool_use")
    expect(event?.modifiedFiles).toEqual(["src/main.ts"])
  })
})

describe("dedup and redaction", () => {
  it("uses the same dedup key for cursor payload forwarded through claude argv", () => {
    const hookInput = {
      conversation_id: "dup-conv",
      transcript_path: "/Users/test/.cursor/chats/t.jsonl",
      hook_event_name: "stop",
      cursor_version: "1.0.0",
    }
    const sha = "shared-sha"

    const cursorDeclared = parseSignal({
      declaredProvider: "cursor",
      declaredEvent: "stop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: sha,
      hookInput,
    })
    const claudeDeclared = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "Stop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: sha,
      hookInput,
    })

    const cursorKey = agentEventDedupKey(hookSignalToAgentEvents(cursorDeclared)[0]!)
    const claudeKey = agentEventDedupKey(hookSignalToAgentEvents(claudeDeclared)[0]!)
    expect(cursorKey).toBe(claudeKey)
    expect(hookSignalToAgentEvents(claudeDeclared)[0]?.secondary).toBe(true)
    expect(hookSignalToActivityDrafts(claudeDeclared)).toEqual([])
  })

  it("redacts sensitive hook input before persistence payloads", () => {
    const redacted = redactValue({
      prompt: "use sk-abcdefghijklmnopqrstuvwxyz1234567890 now",
      api_key: "secret-value",
      input_tokens: 123,
      output_tokens: "456",
      nested: { token: "ghp_1234567890123456789012345678901234" },
    }) as Record<string, unknown>

    expect(String(redacted["prompt"])).toContain("[REDACTED]")
    expect(redacted["api_key"]).toBe("[REDACTED]")
    expect(redacted["input_tokens"]).toBe(123)
    expect(redacted["output_tokens"]).toBe("456")
    expect((redacted["nested"] as Record<string, unknown>)["token"]).toBe("[REDACTED]")
  })
})

describe("chat message projections", () => {
  const withTarget = (body: Record<string, unknown>) =>
    parseSignal({
      ...body,
      arc: {
        chatId: "chat_01",
        targetSessionId: "target_01",
        targetProvider: "claude",
        hookSockPresent: true,
      },
      arcTargetSessionId: "target_01",
      arcChatSessionId: "chat_01",
    })

  it("user prompts and assistant text are both artifact-owned, not hook-drafted", () => {
    // User text moved off the hook stream: the transcript is the single source of
    // truth (projectArtifactSession's user branch), keyed by the message uuid so
    // identical prompts no longer collide on the old content-hash turn fallback.
    const user = withTarget({
      declaredProvider: "claude",
      declaredEvent: "UserPromptSubmit",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "msg-user",
      hookInput: { prompt: "Hello", turn_id: "turn-1" },
    })
    expect(hookSignalToChatMessageDrafts(user)).toEqual([])

    // MessageDisplay deltas no longer persist a draft — they drive only the
    // ephemeral `arc:assistant-stream` overlay (see ArcMainController). The
    // durable bubble comes from the transcript.
    const stream = withTarget({
      declaredProvider: "claude",
      declaredEvent: "MessageDisplay",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "msg-stream",
      hookInput: {
        turn_id: "turn-1",
        message_id: "msg-1",
        index: 0,
        delta: "Hi",
        final: false,
      },
    })
    expect(hookSignalToChatMessageDrafts(stream)).toEqual([])

    // Stop no longer repairs an assistant row — the Stop-time artifact backfill
    // projects the final bubble.
    const stop = withTarget({
      declaredProvider: "claude",
      declaredEvent: "Stop",
      observedAt: "2026-06-04T12:00:02.000Z",
      hookInputSha256: "msg-stop",
      hookInput: { turn_id: "turn-1", last_assistant_message: "Hello there" },
    })
    expect(hookSignalToChatMessageDrafts(stop)).toEqual([])
  })

  it("maps a real Task SubagentStop (named agent_type) to a subagent message", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "SubagentStop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "subagent-real",
      hookInput: {
        agent_id: "agent-7",
        agent_type: "general-purpose",
        last_assistant_message: "PROBE-OK",
      },
    })
    const draft = hookSignalToChatMessageDrafts(signal)[0]
    expect(draft?.role).toBe("subagent")
    expect(draft?.messageId).toBe("agent-7")
    expect(draft?.body).toBe("PROBE-OK")
  })

  it("suppresses implicit-agent SubagentStop (empty agent_type) — recap/suggested-next-message, not a subagent", () => {
    // Claude Code drafts its after-turn suggested next message and its
    // return-from-away recap via implicit agents that fire SubagentStop with
    // agent_type:"". Those are not subagent work and must not project as
    // subagent chat rows.
    const recap = withTarget({
      declaredProvider: "claude",
      declaredEvent: "SubagentStop",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "subagent-implicit",
      hookInput: {
        agent_id: "agent-8",
        agent_type: "",
        last_assistant_message: "You're filing ideas as work items. Next action is your call.",
      },
    })
    expect(hookSignalToChatMessageDrafts(recap)).toEqual([])

    const missingType = withTarget({
      declaredProvider: "claude",
      declaredEvent: "SubagentStop",
      observedAt: "2026-06-04T12:00:02.000Z",
      hookInputSha256: "subagent-no-type",
      hookInput: {
        agent_id: "agent-9",
        last_assistant_message: "implement it",
      },
    })
    expect(hookSignalToChatMessageDrafts(missingType)).toEqual([])
  })

  it("maps a named codex SubagentStop to a subagent message (unified with claude/cursor)", () => {
    // The old per-provider triplet had no codex SubagentStop arm, so codex
    // subagent summaries dropped. The canonical dispatcher routes every
    // provider's SubagentStop through one subagentDraft, keeping the same
    // named-agent_type guard that suppresses implicit-agent noise.
    const named = withTarget({
      declaredProvider: "codex",
      declaredEvent: "SubagentStop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "codex-subagent-named",
      hookInput: {
        agent_id: "codex-agent-1",
        agent_type: "general-purpose",
        last_assistant_message: "CODEX-SUBAGENT-OK",
      },
    })
    const draft = hookSignalToChatMessageDrafts(named)[0]
    expect(draft?.role).toBe("subagent")
    expect(draft?.messageId).toBe("codex-agent-1")
    expect(draft?.body).toBe("CODEX-SUBAGENT-OK")

    // Implicit agents (empty agent_type) are still suppressed for codex too.
    const implicit = withTarget({
      declaredProvider: "codex",
      declaredEvent: "SubagentStop",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "codex-subagent-implicit",
      hookInput: { agent_id: "codex-agent-2", agent_type: "", last_assistant_message: "noise" },
    })
    expect(hookSignalToChatMessageDrafts(implicit)).toEqual([])
  })

  it("does not hook-draft an assistant bubble from a codex Stop (artifact-owned)", () => {
    const signal = withTarget({
      declaredProvider: "codex",
      declaredEvent: "Stop",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "codex-stop-msg",
      hookInput: {
        turn_id: "turn-codex",
        last_assistant_message: "Done.",
      },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("does not map permission requests to durable request messages", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "PermissionRequest",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "perm-request",
      hookInput: {
        turn_id: "turn-perm",
        tool_name: "Bash",
        tool_use_id: "tool-1",
        tool_input: { command: "npm test" },
      },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("maps cursor AskQuestion tool hooks to pending request messages when present", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "preToolUse",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "ask-question",
      hookInput: {
        conversation_id: "conv-ask",
        hook_event_name: "preToolUse",
        tool_name: "AskQuestion",
        tool_use_id: "tool-ask",
        cursor_version: "1.0.0",
        tool_input: {
          title: "Temperature check",
          questions: [
            {
              id: "temperature",
              prompt: "Is it hot or cold?",
              options: [
                { id: "hot", label: "Hot" },
                { id: "cold", label: "Cold" },
              ],
            },
          ],
        },
      },
    })
    const draft = hookSignalToChatMessageDrafts(signal)[0]
    expect(draft?.role).toBe("request")
    expect(draft?.status).toBe("pending")
    expect(draft?.body).toContain("Temperature check")
    expect(draft?.body).toContain("Options:\n- Hot\n- Cold")
    const request = draft?.request
    expect(request?.kind).toBe("question")
    if (request?.kind !== "question") throw new Error("expected question request")
    expect(request.questions[0]?.options).toEqual([
      { label: "Hot", value: "hot" },
      { label: "Cold", value: "cold" },
    ])
  })

  it("maps cursor AskQuestion postToolUse to answered request messages", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "postToolUse",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "ask-question-post",
      hookInput: {
        conversation_id: "conv-ask",
        hook_event_name: "postToolUse",
        tool_name: "AskQuestion",
        tool_use_id: "tool-ask",
        cursor_version: "1.0.0",
        tool_input: {
          title: "Temperature check",
          questions: [
            {
              id: "temperature",
              prompt: "Is it hot or cold?",
              options: [
                { id: "hot", label: "Hot" },
                { id: "cold", label: "Cold" },
              ],
            },
          ],
        },
        result: "Question temperature: Selected option(s) cold",
      },
    })
    const draft = hookSignalToChatMessageDrafts(signal)[0]
    expect(draft?.status).toBe("final")
    const request = draft?.request
    expect(request?.kind).toBe("question")
    if (request?.kind !== "question") throw new Error("expected question request")
    expect(request.state).toBe("answered")
    // The chosen option id ("cold") is mapped to its label and lifted onto the
    // question chip; no raw card-level fallback when the answer is structured.
    expect(request.answer).toBeUndefined()
    expect(request.questions[0]?.answer).toBe("Cold")
    expect(request.questions[0]?.options[1]).toEqual({ label: "Cold", value: "cold" })
  })

  it("maps cursor AskQuestion postToolUseFailure to failed request messages", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "postToolUseFailure",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "ask-question-failed",
      hookInput: {
        conversation_id: "conv-ask",
        hook_event_name: "postToolUseFailure",
        tool_name: "AskQuestion",
        tool_use_id: "tool-ask",
        cursor_version: "1.0.0",
        tool_input: {
          questions: [{ prompt: "Pick one", options: ["a", "b"] }],
        },
        result: "question failed",
      },
    })
    const draft = hookSignalToChatMessageDrafts(signal)[0]
    const request = draft?.request
    expect(request?.kind).toBe("question")
    if (request?.kind !== "question") throw new Error("expected question request")
    expect(draft?.status).toBe("final")
    expect(request.state).toBe("failed")
    expect(request.answer).toBe("question failed")
  })

  it("does not map cursor Read/Grep preToolUse to request messages", () => {
    for (const toolName of ["Read", "Grep"] as const) {
      const signal = withTarget({
        declaredProvider: "cursor",
        declaredEvent: "preToolUse",
        observedAt: "2026-06-04T12:00:00.000Z",
        hookInputSha256: `cursor-${toolName}`,
        hookInput: {
          conversation_id: "conv-tools",
          hook_event_name: "preToolUse",
          tool_name: toolName,
          tool_use_id: `tool-${toolName}`,
          cursor_version: "1.0.0",
          tool_input: { path: "src/main.ts" },
        },
      })
      expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
    }
  })

  it("does not map cursor postToolUse for non-AskQuestion tools to request messages", () => {
    const signal = withTarget({
      declaredProvider: "cursor",
      declaredEvent: "postToolUse",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "cursor-read-post",
      hookInput: {
        conversation_id: "conv-tools",
        hook_event_name: "postToolUse",
        tool_name: "Read",
        tool_use_id: "tool-read",
        cursor_version: "1.0.0",
      },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("ignores Claude AskUserQuestion PermissionRequest hooks without a tool id", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "PermissionRequest",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-ask-user-question",
      hookInput: {
        tool_name: "AskUserQuestion",
        tool_input: {
          questions: [
            {
              question: "Do you like cats or dogs?",
              header: "Pets",
              options: [
                { label: "Cats", description: "You're a cat person." },
                { label: "Dogs", description: "You're a dog person." },
              ],
            },
          ],
        },
      },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("maps Claude AskUserQuestion PreToolUse hooks to pending question request messages", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "PreToolUse",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "claude-ask-user-question-pre",
      hookInput: {
        session_id: "native-claude-session",
        hook_event_name: "PreToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-pets",
        tool_input: {
          questions: [
            {
              question: "Do you like cats or dogs?",
              header: "Pets",
              options: [
                { label: "Cats", description: "You're a cat person." },
                { label: "Dogs", description: "You're a dog person." },
              ],
            },
          ],
        },
      },
    })
    const draft = hookSignalToChatMessageDrafts(signal)[0]
    expect(draft?.role).toBe("request")
    expect(draft?.status).toBe("pending")
    expect(draft?.body).toContain("[Question]")
    expect(draft?.body).toContain("Do you like cats or dogs?")
    expect(draft?.body).toContain("Cats — You're a cat person.")

    const request = draft?.request
    expect(request?.kind).toBe("question")
    if (request?.kind !== "question") throw new Error("expected question request")
    expect(request.state).toBe("pending")
    expect(request.questions).toHaveLength(1)
    expect(request.questions[0]?.prompt).toBe("Do you like cats or dogs?")
    expect(request.questions[0]?.options).toEqual([
      { label: "Cats", value: "Cats", description: "You're a cat person." },
      { label: "Dogs", value: "Dogs", description: "You're a dog person." },
    ])
    // Identity is the tool-use id, not the session: a PreToolUse (pending) and
    // its later PostToolUse (answered) converge on one row, and the key survives
    // `--resume` (which mints a fresh native session id).
    expect(draft?.dedupKey).toBe("target_01:request:tool-pets")
    expect(draft?.dedupKey).not.toContain("native-claude-session")
  })

  it("maps Claude AskUserQuestion PostToolUse hooks to answered question request messages", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "PostToolUse",
      observedAt: "2026-06-04T12:00:01.000Z",
      hookInputSha256: "claude-ask-user-question-post",
      hookInput: {
        session_id: "native-claude-session",
        hook_event_name: "PostToolUse",
        tool_name: "AskUserQuestion",
        tool_use_id: "tool-pets",
        tool_input: {
          questions: [{ question: "Do you like cats or dogs?", options: ["Cats", "Dogs"] }],
        },
        tool_response: {
          answers: { "Do you like cats or dogs?": "Cats" },
        },
      },
    })
    const draft = hookSignalToChatMessageDrafts(signal)[0]
    const request = draft?.request
    expect(draft?.status).toBe("final")
    expect(request?.kind).toBe("question")
    if (request?.kind !== "question") throw new Error("expected question request")
    expect(request.state).toBe("answered")
    // The chosen label is lifted onto the question it answers, not flattened
    // into a JSON blob on the card.
    expect(request.questions[0]?.answer).toBe("Cats")
    expect(request.answer).toBeUndefined()
    // Same session-independent key as the pending PreToolUse above, so the
    // answer replaces the pending row in place (see convergence note above).
    expect(draft?.dedupKey).toBe("target_01:request:tool-pets")
    expect(draft?.dedupKey).not.toContain("native-claude-session")
  })

  it("does not map Claude PermissionRequest tool hooks to durable request messages", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "PermissionRequest",
      observedAt: "2026-06-04T12:01:00.000Z",
      hookInputSha256: "claude-permission-bash",
      hookInput: {
        turn_id: "turn-bash",
        tool_name: "Bash",
        tool_use_id: "tool-bash",
        tool_input: { command: "rm -rf build" },
      },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("does not map Claude PermissionDenied hooks to durable request messages", () => {
    const signal = withTarget({
      declaredProvider: "claude",
      declaredEvent: "PermissionDenied",
      observedAt: "2026-06-04T12:02:00.000Z",
      hookInputSha256: "claude-permission-denied",
      hookInput: {
        turn_id: "turn-bash",
        tool_name: "Bash",
        tool_use_id: "tool-bash",
        tool_input: { command: "rm -rf build" },
      },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("skips drafts without a target session id", () => {
    const signal = parseSignal({
      declaredProvider: "claude",
      declaredEvent: "UserPromptSubmit",
      observedAt: "2026-06-04T12:00:00.000Z",
      hookInputSha256: "no-target",
      hookInput: { prompt: "orphan" },
    })
    expect(hookSignalToChatMessageDrafts(signal)).toEqual([])
  })

  it("does not build durable drafts for permission completions", () => {
    const postToolUse = withTarget({
      declaredProvider: "codex",
      declaredEvent: "PostToolUse",
      observedAt: "2026-06-05T05:45:55.217Z",
      hookInputSha256: "different-post-hash",
      hookInput: { turn_id: "turn-codex", tool_name: "Bash" },
    })

    expect(hookSignalToChatMessageDrafts(postToolUse)).toEqual([])
  })
})

describe("apply_patch classification", () => {
  it("classifies add/update/delete and move-to renames", () => {
    const result = classifyApplyPatchPaths(
      "*** Begin Patch\n*** Update File: old.txt\n*** Move to: new.txt\n*** End Patch\n",
    )
    expect(result.deletedFiles).toEqual(["old.txt"])
    expect(result.newFiles).toEqual(["new.txt"])
  })
})
