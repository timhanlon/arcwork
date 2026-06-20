# Arc Work Hook Reference

This document is Arc's canonical hook map for the target CLIs that
`arc-electron` currently installs hooks for:

- Claude Code via `.claude/settings.local.json`
- Codex via `.codex/hooks.json`
- Cursor via `.cursor/hooks.json`

It documents:

- every hook Arc installs for each target;
- the payload fields Arc should expect;
- what Arc can safely derive from each payload.

Sources used:

- current installer: `src/main/hooks/install.ts`
- current parser/projection: `src/main/hooks/signals.ts`,
  `src/main/hooks/agent-event.ts`
- provider hook docs and observed local hook payloads
- observed local payloads: `.arc/runtime/hook-signals.jsonl`
- official Claude Code hook reference:
  `https://code.claude.com/docs/en/hooks`

## Arc Hook Signal Envelope

Provider hooks do not talk to the renderer directly. Arc installs a single
Arc-owned helper, outside any repo (one copy per profile):

```text
~/.arcwork/<profile>/runtime/arc-hook-signal.mjs
```

Provider hook config invokes it by absolute path, and each Arc-launched shell
also carries that path in `ARC_HOOK_HELPER`. The helper receives the provider's
raw hook JSON on stdin and sends one versioned `HookSignal` record to the main
process over `ARC_HOOK_SOCK`.

Arc wrapper fields:

| Field | Meaning | Arc use |
| --- | --- | --- |
| `schemaVersion` | Arc helper wire schema version | migration / parser compatibility |
| `helperVersion` | generated helper version | debugging |
| `declaredProvider` | provider passed in helper argv | hook config provenance |
| `declaredEvent` | event passed in helper argv | hook config provenance |
| `observedAt` | helper receive time | fallback event ordering |
| `cwd` | hook process cwd | workspace attribution |
| `pid` | hook helper pid | debugging only |
| `argv` | helper argv | debugging/provenance |
| `hookInput` | raw provider payload, parsed when JSON | source of truth |
| `hookInputParseOk` | whether stdin parsed as JSON | diagnostics |
| `hookInputSha256` | hash of raw stdin bytes | dedup/provenance |
| `native.sessionId` | provider session id if known | bind native session |
| `native.transcriptPath` | provider transcript path if known | import/backfill/reconcile |
| `native.conversationId` | Cursor-style conversation id | native session id fallback |
| `native.turnId` | native turn id if present | message/activity grouping |
| `native.toolUseId` | native tool id if present | tool/file attribution |
| `native.hookEventName` | provider event name from payload | payload verification |
| `native.model` | model id if present | model timeline |
| `arc.chatId` | Arc chat id from env | chat attribution |
| `arc.targetSessionId` | Arc target session id from env | target session attribution |
| `arc.targetProvider` | intended target provider from env | mismatch detection |
| `arc.hookSockPresent` | whether helper saw socket env | diagnostics |

Legacy flat fields (`provider`, `event`, `sessionId`, `arcTargetSessionId`,
`arcChatSessionId`, `arcTargetProvider`, `at`) may appear in older logs and are
still readable.

## Git Hooks

Unlike the provider hooks above (gitignored, installed per-launch into
`.claude`/`.codex`/`.cursor`), the git hook is **version-controlled** in
`.githooks/` and wired by `core.hooksPath` (set by the `prepare` script), so it
self-installs for every clone.

```text
.githooks/post-commit             # gates on ARC_HOOK_SOCK, then ships the commit
.githooks/arc-commit-payload.mjs  # prints this commit's metadata as JSON
```

A commit made from an arc-launched shell inherits `ARC_HOOK_SOCK` + the `ARC_*`
tags. `post-commit` builds the commit payload and pipes it through the *same*
generated `arc-hook-signal.mjs`, so it arrives as a standard `HookSignal` with
`declaredProvider: "git"`, `declaredEvent: "post-commit"`, the `ARC_*` tags in
`arc.*`, and the commit fields in `hookInput`:

| `hookInput` field | Meaning |
| --- | --- |
| `sha` | full commit sha (`git rev-parse HEAD`) |
| `branch` | current branch, or `null` on detached HEAD |
| `subject` / `message` | commit subject line / full message |
| `files` | files touched by the commit |
| `author` | `{ name, email }` |
| `committedAt` | committer date (ISO 8601) |

In a plain terminal (no `ARC_HOOK_SOCK`) the hook is a no-op: such commits have
no chat context and stay unlinked, which is correct. `ArcMainController` consumes
the signal, picks the chat's most-recently-updated open work, and stamps a typed
`commit` citation (`WorkService.addCitation`) — the structured replacement for
hand-written "Committed as `<sha>`" notes. A commit from a chat with no work
stays a repo-level raw signal with no citation.

## Product Projections

Hooks should feed multiple Arc product streams. Do not collapse everything into
one "activity" list.

| Product stream | Backing data | Primary hook fields |
| --- | --- | --- |
| `target_sessions` binding | native session metadata | `session_id`, `conversation_id`, `transcript_path` |
| `chat_messages` | user/assistant transcript | `prompt`, `delta`, `message_id`, `index`, `final`, `last_assistant_message` |
| `activity_events` | lifecycle/tool/file/model facts | event name, tool fields, compaction fields, subagent fields |
| artifact import/backfill | full historical transcript | `transcript_path`, `agent_transcript_path` |

Live unified chat should be hook-first:

```text
UserPromptSubmit / beforeSubmitPrompt -> user message
MessageDisplay.delta                  -> streaming assistant chunks
Stop.last_assistant_message           -> final assistant repair/fallback
SubagentStop.last_assistant_message   -> subagent final message or summary
```

Artifact extraction remains necessary for cold-start history, missed hooks,
dedup repair, and richer tool transcript reconstruction.

## Common Native Fields

These fields are common or near-common across targets.

| Field | Providers | Meaning |
| --- | --- | --- |
| `session_id` | Claude, Codex | native session id |
| `conversation_id` | Cursor | native conversation/session id |
| `generation_id` | Cursor | turn/generation id |
| `turn_id` | Claude observed, Codex | native turn id |
| `transcript_path` / `transcriptPath` | all, sometimes nullable | native transcript file |
| `cwd` | Claude, Codex | current working directory |
| `workspace_roots` | Cursor | Cursor workspace roots |
| `hook_event_name` | all | provider event name |
| `model` | all, not every event | model id |
| `permission_mode` | Claude, Codex | provider permission mode |

## Claude Code Hooks

Arc installs the full Claude event set that Claude Code currently exposes
except `FileChanged`. `FileChanged` is intentionally omitted because Claude's
matcher is a literal watch list, not a match-all stream.

Claude common fields:

```json
{
  "session_id": "abc123",
  "transcript_path": "/Users/.../.claude/projects/.../abc123.jsonl",
  "cwd": "/repo",
  "permission_mode": "default",
  "hook_event_name": "EventName"
}
```

### Claude Event Matrix

| Event | Extra payload fields | Arc use |
| --- | --- | --- |
| `SessionStart` | `source`, `model`, optional `agent_type`, optional `session_title` | bind native session; record session start; record model; refresh context on resume |
| `Setup` | `trigger` | setup/maintenance activity only |
| `SessionEnd` | `reason` | mark session ended; cleanup activity |
| `UserPromptSubmit` | `prompt` | create user chat message; start turn; optional title inference |
| `UserPromptExpansion` | `expansion_type`, `command_name`, `command_args`, `command_source`, `prompt` | record slash/MCP prompt expansion; possible user-message provenance if expansion becomes the prompt |
| `MessageDisplay` | `turn_id`, `message_id`, `index`, `delta`, `final` | append/assemble streaming assistant message chunks; finalize when `final` is true |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | record tool start/request; pre-permission context; possible file intent from tool input |
| `PermissionRequest` | `tool_name`, `tool_input`, `tool_use_id`, `permission_suggestions` | record permission prompt; show target waiting/blocked state |
| `PermissionDenied` | `tool_name`, `tool_input`, `tool_use_id`, `reason` | record denied tool attempt |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_use_id`, `tool_response`, `duration_ms` | record tool result; extract file facts for explicit file tools; capture shell output if useful |
| `PostToolUseFailure` | `tool_name`, `tool_input`, `tool_use_id`, error/failure fields | record failed tool result |
| `PostToolBatch` | `tool_calls[]` with each tool input/result | batch-level activity; useful for "all tools completed" and consolidated file observation |
| `Notification` | `message`, optional `title`, `notification_type` | UI notification/waiting state; not transcript |
| `SubagentStart` | `agent_id`, `agent_type` | subagent lifecycle; optional subagent context |
| `SubagentStop` | `stop_hook_active`, `agent_id`, `agent_type`, `agent_transcript_path`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` | subagent lifecycle; subagent final message; import subagent transcript; task summary |
| `TaskCreated` | `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name` | task lifecycle; task board/progress |
| `TaskCompleted` | `task_id`, `task_subject`, optional `task_description`, `teammate_name`, `team_name` | task lifecycle; completion summary |
| `TeammateIdle` | `teammate_name`, `team_name` | teammate idle/waiting state |
| `Stop` | `stop_hook_active`, `last_assistant_message`, `background_tasks[]`, `session_crons[]` | finalize turn; repair assistant message from `last_assistant_message`; detect background work |
| `StopFailure` | `error`, optional `error_details`, optional `last_assistant_message` | failed turn; preserve partial final assistant text if present |
| `InstructionsLoaded` | instruction/source fields from Claude | instruction provenance/activity |
| `ConfigChange` | `source`, optional `file_path` | configuration activity; possible file observed |
| `CwdChanged` | `old_cwd`, `new_cwd` | update current cwd display; workspace/path activity |
| `WorktreeCreate` | `name` | worktree lifecycle; do not let Arc helper alter stdout path contract |
| `WorktreeRemove` | `worktree_path` | worktree lifecycle/cleanup activity |
| `PreCompact` | `trigger`, `custom_instructions` | compaction start; record custom compact instructions |
| `PostCompact` | `trigger`, `compact_summary` | compaction end; store compact summary |
| `Elicitation` | `mcp_server_name`, `message`, optional `mode`, `url`, `elicitation_id`, `requested_schema` | MCP user-input request; waiting/input-needed state |
| `ElicitationResult` | `mcp_server_name`, `action`, optional `mode`, `elicitation_id`, `content` | MCP input result; resume state |

Claude message handling:

- `UserPromptSubmit.prompt` is the user message.
- `MessageDisplay` is the live assistant stream. Key by
  `(targetSessionId, turn_id, message_id)`, order by `index`, append `delta`,
  mark final on `final: true`.
- `Stop.last_assistant_message` is the authoritative final assistant fallback.
  Use it to repair a missing/incomplete `MessageDisplay` stream for the turn.
- `SubagentStop.last_assistant_message` is the subagent final response. Display
  as a subagent message or fold into activity depending on UI mode, but retain
  it as message text.

Claude file handling:

- `PostToolUse` and `PostToolBatch` are the primary hook sources for tool-driven
  file activity.
- File tools commonly expose paths in `tool_input.file_path`,
  `tool_input.notebook_path`, or MCP-specific fields.
- Bash/shell commands may imply file changes, but hook payload alone is not a
  reliable parser for arbitrary shell side effects; use git diff or artifact
  reconciliation if exact attribution matters.

## Codex Hooks

Arc installs:

```text
SessionStart
UserPromptSubmit
PreToolUse
PermissionRequest
PostToolUse
PreCompact
PostCompact
SubagentStart
SubagentStop
Stop
```

Codex common fields observed in local logs:

```json
{
  "session_id": "019e...",
  "turn_id": "019e...",
  "transcript_path": "/Users/.../.codex/sessions/.../rollout-....jsonl",
  "cwd": "/repo",
  "hook_event_name": "EventName",
  "model": "gpt-5.5",
  "permission_mode": "default"
}
```

### Codex Event Matrix

| Event | Extra payload fields | Arc use |
| --- | --- | --- |
| `SessionStart` | `source`, `model` | bind native session; record session start/model |
| `UserPromptSubmit` | `prompt` | create user chat message; start turn |
| `PreToolUse` | `tool_name`, `tool_input`, `tool_use_id` | record tool start/request |
| `PermissionRequest` | `tool_name`, `tool_input`, possibly permission suggestion fields | target waiting/permission state |
| `PostToolUse` | `tool_name`, `tool_input`, `tool_response`, `tool_use_id`, `duration_ms` | record tool result; extract file facts for `apply_patch`/`Write`/`Edit` aliases |
| `PreCompact` | trigger/context fields if provided | compaction start |
| `PostCompact` | summary/context fields if provided | compaction end/summary |
| `SubagentStart` | `subagent_id`, `agent_type`/`subagent_type`, `description` when provided | subagent lifecycle |
| `SubagentStop` | `subagent_id`, optional final/summary fields if provided | subagent lifecycle; possible subagent final text |
| `Stop` | `stop_hook_active`, `last_assistant_message`, model/session fields | finalize turn; create/repair assistant chat message |

Codex message handling:

- `UserPromptSubmit.prompt` is the user message.
- `Stop.last_assistant_message` is the final assistant message. Local observed
  payloads contain it; Arc's Codex hook projection uses it to create/repair the
  assistant chat message.
- Codex does not currently have an Arc-installed streaming `MessageDisplay`
  equivalent in this repo. Treat `Stop.last_assistant_message` as the primary
  live assistant message source.
- If future Codex hooks add streaming chunks, add them to the same
  `(targetSessionId, turn_id, nativeMessageId)` message assembly path.

Codex file handling:

- `PostToolUse.tool_name` values `apply_patch`, `Write`, and `Edit` are
  mutating tool aliases.
- For `apply_patch`, `tool_input.command` contains the patch envelope. Parse:
  - `*** Add File:` -> added file
  - `*** Update File:` -> modified file
  - `*** Delete File:` -> deleted file
  - `*** Move to:` after an update -> delete old path and add new path
- Do not infer arbitrary shell side effects from non-mutating tool names without
  git diff reconciliation.

## Cursor Hooks

Arc installs:

```text
sessionStart
sessionEnd
workspaceOpen
beforeSubmitPrompt
preToolUse
postToolUse
postToolUseFailure
beforeShellExecution
afterShellExecution
beforeMCPExecution
afterMCPExecution
beforeReadFile
afterFileEdit
beforeTabFileRead
afterTabFileEdit
subagentStart
subagentStop
preCompact
afterAgentResponse
afterAgentThought
stop
```

Cursor common fields from observed community payloads:

```json
{
  "conversation_id": "conv-123",
  "generation_id": "gen-456",
  "model": "default",
  "hook_event_name": "beforeSubmitPrompt",
  "cursor_version": "2.x",
  "workspace_roots": ["/repo"],
  "user_email": "",
  "transcript_path": "/path/or/null"
}
```

Cursor IDE and Cursor CLI differ:

- IDE often provides `transcript_path`; CLI may send `null`.
- IDE may include `composer_mode`; CLI may omit it.
- CLI/headless modes may skip some prompt/stop hooks.

### Cursor Event Matrix

| Event | Extra payload fields | Arc use |
| --- | --- | --- |
| `sessionStart` | `is_background_agent`, `composer_mode` | bind conversation; record session start/model |
| `sessionEnd` | `reason`, `duration_ms`, `is_background_agent`, `final_status` | mark session ended; duration/status |
| `workspaceOpen` | workspace fields | workspace activity only |
| `beforeSubmitPrompt` | `prompt` | create user chat message; start turn/generation |
| `preToolUse` | tool fields; shape varies by tool | tool start/request |
| `postToolUse` | tool fields/result fields | tool result; possible file/activity facts |
| `postToolUseFailure` | tool fields/error fields | failed tool result |
| `beforeShellExecution` | command/shell fields | shell command start |
| `afterShellExecution` | command/result/duration fields | shell command result; possible activity |
| `beforeMCPExecution` | MCP server/tool/input fields | MCP call start |
| `afterMCPExecution` | MCP server/tool/result fields | MCP call result |
| `beforeReadFile` | file path fields | read activity; source context |
| `afterFileEdit` | `file_path` / `filePath` and edit metadata | file observed/modified |
| `beforeTabFileRead` | tab/file fields | IDE read activity |
| `afterTabFileEdit` | tab/file edit fields | file observed/modified |
| `subagentStart` | `subagent_id`, `subagent_type`, `subagent_model`, `task`, `parent_conversation_id`, `tool_call_id`, `is_parallel_worker` | subagent lifecycle; task text |
| `subagentStop` | `subagent_id`, `subagent_type`, `status`, `duration_ms`, `summary`, `parent_conversation_id`, `message_count`, `tool_call_count`, `modified_files[]`, `loop_count`, `task`, `description`, `agent_transcript_path` | subagent completion; summary; modified files; transcript backfill |
| `preCompact` | `trigger`, `context_usage_percent`, `context_tokens`, `context_window_size`, `message_count`, `messages_to_compact`, `is_first_compaction` | compaction warning/start; context metrics |
| `afterAgentResponse` | private/correlation payload; observed fields may include common fields and response identifiers/text depending on Cursor version | possible assistant message source; treat as unstable until captured locally |
| `afterAgentThought` | private/correlation payload; thought fields vary | thought/diagnostic event, not default chat message |
| `stop` | `status`, `loop_count`; possibly final response fields depending on version | finalize turn; repair assistant message only if payload provides text |

Cursor message handling:

- `beforeSubmitPrompt.prompt` is the user message.
- `afterAgentResponse` is the likely live assistant response hook, but Arc
  should treat its payload shape as version-sensitive until local captured
  examples are added to tests.
- `stop` finalizes the turn. Use response text from `stop` only when the payload
  explicitly includes it.
- Cursor transcript import is still useful because Cursor hook coverage varies
  between IDE, CLI, background agents, and headless modes.

Cursor file handling:

- `afterFileEdit` / `afterTabFileEdit` are direct file-observation hooks.
- `subagentStop.modified_files[]` is a strong file-attribution signal.
- Shell and MCP hooks are activity signals; exact file attribution may require
  git diff reconciliation.

## Dedup and Ordering Rules

Use stable native identifiers whenever possible:

| Entity | Key |
| --- | --- |
| user message | `(targetSessionId, turn_id/generation_id, "user")` |
| Claude streaming assistant message | `(targetSessionId, turn_id, message_id)` |
| Codex final assistant message | `(targetSessionId, turn_id, "assistant-final")` |
| Cursor generation message | `(targetSessionId, generation_id, native message id if present)` |
| tool activity | `(targetSessionId, tool_use_id, hook_event_name)` |
| file fact | `(tool activity key, path, changeKind)` |

Ordering:

1. Prefer provider `turn_id` / `generation_id` grouping.
2. For Claude `MessageDisplay`, order chunks by `index`.
3. Use `observedAt` only as a fallback display order.
4. On final repair (`Stop.last_assistant_message`), upsert via `repair_turn`:
   replace the existing `MessageDisplay` row for the turn (or the keyed
   `message_id` when present) and delete any other assistant rows for that turn.
   Codex/Cursor finals without a stream use `assistant-final` dedup only.

## Implementation Status (arc-electron)

Implemented:

- `chat_messages` SQLite storage with dedup-key upsert (insert / append / replace);
- hook projection in `src/main/hooks/chat-message.ts`:
  - Claude: `UserPromptSubmit`, `MessageDisplay`, `Stop`, `SubagentStop`;
  - Codex: `UserPromptSubmit`, `Stop` (`last_assistant_message`);
  - Cursor: `beforeSubmitPrompt`, `afterAgentResponse`, `stop`, `subagentStop`;
- `ListChatMessages` RPC and `arc:chat-messages` live push;
- `UnifiedChatPane` renders hook-projected messages; lifecycle/tool/file facts
  stay in collapsible `activity_events`.

Still open:

- artifact import/backfill from `transcript_path` for cold-start history;
- richer Cursor `afterAgentResponse` / `stop` payload capture as versions land;
- Claude `PostToolUse` / `PostToolBatch` file facts already map to activity, not chat.
