import type { ReactNode } from "react"
import type { ChatMessage } from "../../../shared/chat-message.js"
import { arcId } from "../../../shared/ids.js"
import { Message } from "./Message.js"

export default {
  title: "Chat / Message",
}

const List = ({ children }: { readonly children: ReactNode }) => (
  <ul style={{ width: 520, maxWidth: "100%", listStyle: "none", margin: 0, padding: 0 }}>
    {children}
  </ul>
)

const msg = (
  over: Partial<Omit<ChatMessage, "id" | "chatId" | "targetSessionId">> & {
    readonly id?: string
    readonly chatId?: string
    readonly targetSessionId?: string
  },
): ChatMessage => ({
  _tag: "ChatMessage",
  role: "assistant",
  body: "",
  status: "final",
  occurredAt: "2026-06-01T19:48:51.124Z",
  source: "artifact:claude",
  ...over,
  id: arcId("message", over.id ?? "msg_01"),
  chatId: arcId("chat", over.chatId ?? "chat_01"),
  targetSessionId: arcId("target", over.targetSessionId ?? "target_01"),
})

/** Recap with both Goal and Next — the common "picking up where you left off" shape. */
export const RecapGoalAndNext = () => (
  <List>
    <Message
      target="claude"
      message={msg({
        role: "recap",
        body:
          "Goal: extract token-usage data in arc-ingest. I scanned the corpus and wrote " +
          "docs/token-usage-metadata.md documenting how Claude, Codex, and Cursor each store usage. " +
          "Next: you pick a storage shape so I can wire up extraction. (disable recaps in /config)",
      })}
    />
  </List>
)

/** Recap that opens without the `Goal:` label but still carries a Next clause. */
export const RecapNoGoalLabel = () => (
  <List>
    <Message
      target="claude"
      message={msg({
        role: "recap",
        body:
          "Goal was to extract token-usage data into arc-ingest. I documented it and committed " +
          "docs/token-usage-metadata.md. Next: decide the storage shape and wire up extraction.",
      })}
    />
  </List>
)

/** Recap with neither marker — degrades to the raw text, no labelled sections. */
export const RecapOpaque = () => (
  <List>
    <Message
      target="claude"
      message={msg({
        role: "recap",
        body: "You committed two arc-prototype changes and pushed them to main.",
      })}
    />
  </List>
)

/** A recap beside an assistant turn, to check the card reads as distinct. */
export const RecapInContext = () => (
  <List>
    <Message
      target="claude"
      message={msg({ id: "a", role: "assistant", model: "claude-opus-4-8", body: "Done — committed and pushed." })}
    />
    <Message
      target="claude"
      message={msg({
        id: "r",
        role: "recap",
        body: "Goal: ship the recap card. Next: verify it in Storybook.",
      })}
    />
  </List>
)

/** A subagent's body is the full prompt it was dispatched with — collapsed by
 * default (≈4 lines + "show more") so a long Explore/Task prompt doesn't bury the
 * transcript, expandable on demand. */
export const SubagentCollapsed = () => (
  <List>
    <Message
      target="claude"
      message={msg({
        role: "subagent",
        body:
          "In the Arc Work app (under /Users/you/dev/aux), I'm investigating a bug: " +
          '"Right panel toggle key binding does not work."\n\n' +
          "Find everything related to the right panel and its toggle keybinding in the renderer code. " +
          "Specifically:\n\n" +
          "1. Where the \"right panel\" is defined/rendered (a side panel, inspector, detail panel).\n" +
          "2. The keyboard shortcut / key binding that is supposed to toggle it open/closed.\n" +
          "3. How keybindings are registered/dispatched in this app (central keymap, useKeydown hook, " +
          "Electron accelerator, etc.).\n" +
          "4. Any other panel toggles (e.g. left sidebar toggle) that DO work, to compare the working " +
          "path against the broken right-panel path.\n\n" +
          "Report concrete file paths and line numbers, the relevant code excerpts, and your read on " +
          "where the wiring breaks.",
      })}
    />
  </List>
)

/** A short subagent prompt stays fully visible — nothing to collapse, no toggle. */
export const SubagentShort = () => (
  <List>
    <Message target="claude" message={msg({ role: "subagent", body: "Find the right panel toggle keybinding." })} />
  </List>
)

/** Explore/Task subagents often open with a markdown H1 — the bold heading should
 * fade behind the collapse gradient, not bleed through it. Regression fixture for
 * the subagent card's `Collapsible` + `MarkdownBody` stack. */
export const SubagentExploreWithHeading = () => (
  <List>
    <Message
      target="claude"
      message={msg({
        role: "subagent",
        model: "claude-sonnet-4-6",
        body:
          "# Map the right-panel toggle wiring\n\n" +
          "Find everything related to the right panel and its toggle keybinding in the renderer code. " +
          "Specifically:\n\n" +
          "1. Where the \"right panel\" is defined/rendered (a side panel, inspector, detail panel).\n" +
          "2. The keyboard shortcut / key binding that is supposed to toggle it open/closed.\n" +
          "3. How keybindings are registered/dispatched in this app (central keymap, useKeydown hook, " +
          "Electron accelerator, etc.).\n" +
          "4. Any other panel toggles (e.g. left sidebar toggle) that DO work, to compare the working " +
          "path against the broken right-panel path.\n\n" +
          "Report concrete file paths and line numbers, the relevant code excerpts, and your read on " +
          "where the wiring breaks.",
      })}
    />
  </List>
)

/** Programmatic (isMeta) prompt — a ScheduleWakeup/`/loop` re-submission. Muted,
 * faded, no accent: it must read as an automated turn, not a typed user prompt. */
export const MetaWakeup = () => (
  <List>
    <Message
      target="claude"
      message={msg({
        role: "meta",
        body: "Check the full test suite result, then close out work_01ktjh… if it's green.",
      })}
    />
  </List>
)

/** User prompt with target attribution — mirrors the composer "to …" line. */
export const UserWithTarget = () => (
  <List>
    <Message
      target="claude"
      message={msg({ role: "user", body: "add target attribution to user messages" })}
    />
  </List>
)

/** Multi-target chat: user prompts must show which session received each message. */
export const MultiTargetExchange = () => (
  <List>
    <Message
      target="claude · a1b2"
      message={msg({ id: "u1", role: "user", targetSessionId: "target_claude", body: "refactor the hook ingest path" })}
    />
    <Message
      target="claude · a1b2"
      message={msg({
        id: "a1",
        role: "assistant",
        targetSessionId: "target_claude",
        model: "claude-opus-4-8",
        body: "On it — starting with chat-message.ts.",
      })}
    />
    <Message
      target="cursor · c3d4"
      message={msg({ id: "u2", role: "user", targetSessionId: "target_cursor", body: "run the electron tests" })}
    />
    <Message
      target="cursor · c3d4"
      message={msg({
        id: "a2",
        role: "assistant",
        targetSessionId: "target_cursor",
        model: "composer-2.5",
        body: "Tests passed.",
      })}
    />
  </List>
)

/** A meta prompt between a real user turn and the assistant reply, so the muted
 * card can be compared against the accented user card directly above it. */
export const MetaInContext = () => (
  <List>
    <Message
      target="claude"
      message={msg({ id: "u", role: "user", body: "fix the isMeta projection bug" })}
    />
    <Message
      target="claude"
      message={msg({
        id: "m",
        role: "meta",
        body: "Base directory for this skill: /Users/you/dev/aux/.claude/skills/arc-work",
      })}
    />
    <Message
      target="claude"
      message={msg({ id: "a", role: "assistant", model: "claude-opus-4-8", body: "On it." })}
    />
  </List>
)
