import type { Provider } from "./provider.js"

/**
 * Representative argument/output fixtures for each {@link TOOL_CATALOG} entry,
 * used by the Storybook grid and the coverage test. Kept OUT of
 * `tool-catalog.ts` so these (sometimes large) fixtures never reach the
 * main/renderer bundles — only stories and tests import this module.
 *
 * Keyed `${provider}:${name}` ({@link sampleKey}). Args are real shapes drawn
 * from ingested transcripts (trimmed), so the grid exercises the exact
 * per-provider arg spellings the renderer must handle (codex `cmd`, cursor
 * `contents`/`glob_pattern`, …). A row without a sample here is a coverage gap
 * the test flags.
 */

export interface ToolSample {
  readonly args: unknown
  readonly output?: string
}

export const sampleKey = (provider: Provider, name: string): string => `${provider}:${name}`

export const TOOL_SAMPLES: Readonly<Record<string, ToolSample>> = {
  // ── Claude Code ────────────────────────────────────────────────────────────
  "claude:Bash": {
    args: { command: "pnpm test 2>&1 | tail -5", description: "Run the suite" },
    output: ["Test Files  25 passed (25)", "     Tests  182 passed (182)"].join("\n"),
  },
  "claude:BashOutput": {
    args: { bash_id: "bash_1" },
    output: "Progress: 5/5\nDone.",
  },
  "claude:KillShell": { args: { shell_id: "bash_1" }, output: "Shell bash_1 killed." },
  "claude:Read": { args: { file_path: "package.json" }, output: '{\n  "name": "arcwork"\n}' },
  "claude:NotebookRead": { args: { notebook_path: "analysis.ipynb" } },
  "claude:Write": {
    args: {
      file_path: "/Users/you/dev/aux/src/renderer/src/components/tool-body.tsx",
      content: ['import { Label } from "./Label.js"', "", 'export const CODE = "..."'].join("\n"),
    },
    output: "File created successfully.",
  },
  "claude:Edit": {
    args: {
      file_path: "/Users/you/dev/aux/src/main/services/ArcMainController.ts",
      old_string: "const watcher = fs.watch(transcriptPath, listener)",
      new_string: "fs.watchFile(transcriptPath, { interval: POLL_MS }, listener)",
    },
    output: "The file ArcMainController.ts has been updated successfully.",
  },
  "claude:MultiEdit": {
    args: {
      file_path: "/Users/you/dev/aux/src/cli.ts",
      edits: [
        { old_string: "const port = 3000", new_string: "const port = env.PORT ?? 3000" },
        { old_string: "log('start')", new_string: "log('starting', { port })" },
      ],
    },
  },
  "claude:NotebookEdit": {
    args: { notebook_path: "analysis.ipynb", cell_type: "code", new_source: "df.describe()" },
  },
  "claude:Glob": { args: { pattern: "**/*.stories.tsx", path: "src/renderer" }, output: "src/renderer/src/components/ToolCall.stories.tsx" },
  "claude:Grep": { args: { pattern: "fs.watch", path: "src/main" }, output: "src/main/services/ArcMainController.ts:109" },
  "claude:WebFetch": {
    args: { url: "https://code.claude.com/docs/en/hooks-guide", prompt: "Summarize the hook events" },
    output: "Fetched 3 sections.",
  },
  "claude:WebSearch": { args: { query: "AgentMail email infrastructure for AI agents 2025" }, output: "1. agentmail.io — …" },
  "claude:ToolSearch": { args: { query: "select:mcp__codex__codex", max_results: 1 } },
  "claude:Agent": {
    args: { description: "Research subagent delegation", subagent_type: "Explore", prompt: "Explore the repo and report how subagents are spawned…" },
    output: "Reported back: agents are spawned via the Task tool…",
  },
  "claude:Task": { args: { description: "Explore structure", prompt: "Map the project layout and report concisely." } },
  "claude:TaskCreate": { args: { subject: "Thread cols/rows through C spawn", description: "Add cols/rows params to arc_spawn_pty, defaulting to 80x24" } },
  "claude:TaskUpdate": { args: { taskId: "1", status: "in_progress" } },
  "claude:TaskList": { args: {} },
  "claude:TodoWrite": {
    args: { todos: [{ content: "Build catalog", status: "in_progress", activeForm: "Building catalog" }, { content: "Wire stories", status: "pending", activeForm: "Wiring stories" }] },
  },
  "claude:Skill": { args: { skill: "code-review" } },
  "claude:Workflow": { args: { script: "export const meta = {\n  name: 'review-changes',\n  description: 'Review the diff',\n}\nphase('Review')\n…" } },
  "claude:ScheduleWakeup": {
    args: { delaySeconds: 60, reason: "Waiting for the suite to finish, then report and close the work item.", prompt: "Check the test result and close work_01…" },
  },
  "claude:EnterPlanMode": { args: {} },
  "claude:ExitPlanMode": { args: { plan: "## Plan\n1. Build the catalog\n2. Wire the grid story" } },
  "claude:AskUserQuestion": {
    args: {
      questions: [
        { question: "How should we kick off?", header: "Next step", multiSelect: false, options: [{ label: "Scaffold the repo", description: "Set up package.json, tsconfig, CLI entry" }, { label: "Spike the runtime", description: "Prototype the Effect seam first" }] },
      ],
    },
  },
  // ── Codex CLI ──────────────────────────────────────────────────────────────
  "codex:exec_command": {
    args: { cmd: "rg --files docs/proposals", workdir: "/Users/you/dev/aux", yield_time_ms: 10000, max_output_tokens: 12000 },
    output: "docs/proposals/2026-06-06-sidebar-work-queue.md",
  },
  "codex:shell": { args: { command: ["bash", "-lc", "ls -1 src | head"] }, output: "main\nrenderer\nshared" },
  "codex:write_stdin": { args: { session_id: 87865, chars: "y\n", yield_time_ms: 1000, max_output_tokens: 20000 } },
  "codex:apply_patch": {
    args: {
      input: [
        "*** Begin Patch",
        "*** Add File: src/new-helper.ts",
        "+export const ok = true",
        "*** Update File: src/main.ts",
        "@@",
        '-const status = "pending"',
        '+const status = "ready"',
        "*** Delete File: src/old-helper.ts",
        "-export const stale = true",
        "*** End Patch",
      ].join("\n"),
    },
    output: "Success. Updated the following files:\nA src/new-helper.ts\nM src/main.ts\nD src/old-helper.ts",
  },
  "codex:update_plan": {
    args: { plan: [{ step: "Inventory hook sources", status: "in_progress" }, { step: "Draft canonical HOOKS.md", status: "pending" }, { step: "Verify against code", status: "pending" }] },
  },
  "codex:view_image": { args: { path: "/Users/you/dev/aux/.tmp/shot.png", detail: "high" } },
  "codex:request_user_input": {
    args: {
      questions: [
        { header: "Color", id: "favorite_color", question: "What is your favorite color?", options: [{ label: "Blue (Recommended)", description: "Select if blue is your favorite." }, { label: "Green", description: "Select if green is your favorite." }] },
      ],
    },
  },
  // ── Cursor CLI ─────────────────────────────────────────────────────────────
  "cursor:Shell": {
    args: { command: "cd /Users/you/dev/aux && npm test 2>&1", description: "Re-run tests" },
    output: "Test Suites: 1 passed",
  },
  "cursor:Read": { args: { path: "/Users/you/dev/aux/src/cli.ts" } },
  "cursor:Write": { args: { path: "/Users/you/dev/arc-test/TEST.md", contents: "hello\n" }, output: "Wrote 6 bytes." },
  "cursor:StrReplace": {
    args: { path: "/Users/you/dev/aux/todo/2026-05-31-arc-hooks.md", old_string: "status: ready", new_string: "status: done" },
    output: "Applied 1 replacement.",
  },
  "cursor:MultiStrReplace": {
    args: { path: "/Users/you/dev/aux/src/cli.ts", replacements: [{ old_string: "const a = 1", new_string: "const a = 2" }, { old_string: "const b = 1", new_string: "const b = 3" }] },
  },
  "cursor:Delete": { args: { path: "/Users/you/dev/aux/tsconfig.check-temp.json" }, output: "Deleted." },
  "cursor:Glob": { args: { glob_pattern: "**/cli.ts", target_directory: "/Users/you/dev/arc-test" }, output: "src/cli.ts" },
  "cursor:Grep": { args: { pattern: "fs\\.stat", path: "/Users/you/dev/arc-test" }, output: "src/services/artifact-store.ts:42" },
  "cursor:SemanticSearch": { args: { query: "CLI hooks SessionStart clear new session", target_directories: [] } },
  "cursor:WebFetch": { args: { url: "https://code.claude.com/docs/en/hooks-guide" } },
  "cursor:WebSearch": { args: { search_term: "Claude Code /new command SessionStart hook source", explanation: "Check whether /new is a distinct SessionStart source." } },
  "cursor:TodoWrite": {
    args: { todos: [{ id: "1", content: "Add parse-jsonc, agents loader", status: "in_progress" }, { id: "2", content: "Update types, schemas, errors", status: "pending" }] },
  },
  "cursor:Task": { args: { description: "Explore arcwork structure", prompt: "Explore the arcwork project and report the architecture…" } },
  "cursor:ReadLints": {
    args: { paths: ["/Users/you/dev/aux/src/services/artifact-store.ts", "/Users/you/dev/aux/src/cli.ts"] },
    output: "No lint errors.",
  },
  "cursor:AskQuestion": {
    args: { title: "Temperature check", questions: [{ id: "temperature", prompt: "Is it hot or cold?", options: [{ id: "hot", label: "Hot" }, { id: "cold", label: "Cold" }] }] },
  },
  // ── pi (local) ───────────────────────────────────────────────────────────
  "pi:bash": { args: { command: "cat note.txt" }, output: "hello\nworld" },
  "pi:read": { args: { path: "note.txt" }, output: "hello\nworld" },
  "pi:write": { args: { path: "out.txt", content: "done" } },
  "pi:edit": { args: { path: "note.txt", edits: [{ oldText: "world", newText: "earth" }] } },
  "pi:ls": { args: { path: "src" } },
  "pi:grep": { args: { pattern: "hello", path: "note.txt" } },
  "pi:find": { args: { pattern: "*.ts", path: "src" } },
}
