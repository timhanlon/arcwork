import type { ReactNode } from "react"
import type { ToolCall as ToolCallData } from "../../../../shared/tool-call.js"
import { ToolCall } from "./ToolCall.js"

// The Claude-in-Chrome MCP toolkit (`mcp__claude-in-chrome__<verb>`) rendered
// through ToolCall — the action cards that replace the generic raw-JSON MCP
// fallback. Each browser call surfaces what it *did*: the URL it navigated to,
// the click target, the typed text, the script it ran. Sibling story
// `Chat / ArcToolCall` covers the arc toolkit; `Chat / ToolCall` the first-party
// (catalog) tools.
export default {
  title: "Chat / ChromeToolCall",
}

const Frame = ({ children }: { readonly children: ReactNode }) => (
  <div
    style={{
      width: 460,
      maxWidth: "100%",
      padding: "10px 12px",
      border: "1px solid var(--border)",
      borderLeft: "2px solid var(--border)",
      background: "var(--elev)",
    }}
  >
    {children}
  </div>
)

const Case = ({ label, tool }: { readonly label: string; readonly tool: ToolCallData }) => (
  <div>
    <div
      style={{
        marginBottom: 6,
        fontFamily: "var(--font-mono, monospace)",
        fontSize: 11,
        color: "var(--fg-dim)",
      }}
    >
      {label}
    </div>
    <Frame>
      <ToolCall tool={tool} provider="claude" />
    </Frame>
  </div>
)

const tool = (
  toolName: string,
  args: unknown,
  output?: string,
  state: ToolCallData["state"] = "output-available",
): ToolCallData => ({ kind: "tool", state, toolName, args, ...(output ? { output } : {}) })

const name = (verb: string): string => `mcp__claude-in-chrome__${verb}`

// ── cases ─────────────────────────────────────────────────────────────────────

/** Navigation — the URL is the whole story, with the target tab beneath it. */
export const Navigate = () => (
  <Case
    label="chrome.navigate"
    tool={tool(name("navigate"), { url: "https://arcwork.run/docs", tabId: "tab_1" }, "Loaded https://arcwork.run/docs")}
  />
)

/** A new tab — marker chip + the URL it opens at. */
export const TabsCreate = () => (
  <Case label="chrome.tabs_create" tool={tool(name("tabs_create_mcp"), { url: "https://github.com/anthropics" })} />
)

/** The workhorse `computer` tool — a click, with its action and coordinate. */
export const ComputerClick = () => (
  <Case label="chrome.computer (click)" tool={tool(name("computer"), { action: "left_click", coordinate: [412, 280] })} />
)

/** A `computer` type — action chip + the text being entered. */
export const ComputerType = () => (
  <Case
    label="chrome.computer (type)"
    tool={tool(name("computer"), { action: "type", text: "claude code browser automation" })}
  />
)

/** A `computer` screenshot — action alone; result is the captured frame note. */
export const ComputerScreenshot = () => (
  <Case label="chrome.computer (screenshot)" tool={tool(name("computer"), { action: "screenshot" }, "Captured 1280×800 screenshot.")} />
)

/** Page scripting — the code (carried in `text`) runs through the shared CodeBlock. */
export const RunScript = () => (
  <Case
    label="chrome.javascript_tool"
    tool={tool(name("javascript_tool"), {
      action: "javascript_exec",
      text: ["const links = [...document.querySelectorAll('a')]", "console.log(links.length)"].join("\n"),
      tabId: 971586735,
    })}
  />
)

/** A batched sequence — each sub-action (`{name, input}`) renders through the
 * same per-verb dispatch as a standalone call. The real shape, from ingest. */
export const BrowserBatch = () => (
  <Case
    label="chrome.browser_batch"
    tool={tool(name("browser_batch"), {
      actions: [
        { name: "navigate", input: { url: "http://localhost:6006/?path=/story/chat-question--answered", tabId: 971586898 } },
        { name: "computer", input: { action: "wait", duration: 2, tabId: 971586898 } },
        { name: "computer", input: { action: "left_click", coordinate: [463, 111], tabId: 971586898 } },
        { name: "computer", input: { action: "screenshot", tabId: 971586898 } },
      ],
    })}
  />
)

/** Filtered console read — the regex pattern it scoped to. */
export const ReadConsole = () => (
  <Case label="chrome.read_console_messages" tool={tool(name("read_console_messages"), { pattern: "\\[MyApp\\]" })} />
)

/** A thin read with no salient arg — body collapses to the verb header alone. */
export const ReadPage = () => <Case label="chrome.read_page" tool={tool(name("read_page"), { tabId: "tab_1" })} />

/** A pending navigation (no result yet). */
export const Pending = () => (
  <Case label="chrome.navigate (pending)" tool={tool(name("navigate"), { url: "https://example.com" }, undefined, "input-available")} />
)

/** Every case stacked, the way a transcript shows them. */
export const All = () => (
  <div style={{ display: "grid", gap: 22 }}>
    <Navigate />
    <TabsCreate />
    <ComputerClick />
    <ComputerType />
    <ComputerScreenshot />
    <RunScript />
    <BrowserBatch />
    <ReadConsole />
    <ReadPage />
    <Pending />
  </div>
)
