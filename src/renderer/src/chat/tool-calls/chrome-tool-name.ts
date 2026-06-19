// Parsing of "Claude in Chrome" MCP tool-call names as they land in ingested
// transcripts. Pure string logic (no rendering), split out from
// `chrome-tool-body.tsx` so it can be unit-tested under the plain-Node runner —
// the same split as `arc-tool-name.ts`.
//
// The browser toolkit is exposed by an MCP server named `claude-in-chrome`, so
// its tools arrive namespaced. Unlike the arc toolkit (which Codex also calls,
// emitting a bare `arc_<verb>`), these are Claude-Code-only and always carry the
// server namespace, so we only claim the namespaced forms — a bare `navigate`
// has no server prefix to disambiguate and must not be hijacked:
//   Claude → `mcp__claude-in-chrome__<verb>`   (double-underscore namespacing)
//   Cursor → `mcp_claude-in-chrome_<verb>`     (single-underscore namespacing)
const CHROME_NAMESPACE_PREFIXES = ["mcp__claude-in-chrome__", "mcp_claude-in-chrome_"] as const

/** The namespace prefix this name carries, if any. */
const matchPrefix = (name: string): string | undefined =>
  CHROME_NAMESPACE_PREFIXES.find((prefix) => name.startsWith(prefix))

/** True for a Claude-in-Chrome toolkit call across Claude/Cursor name flattening. */
export const isChromeTool = (name: string): boolean => matchPrefix(name) !== undefined

/** The bare verb after the namespace: `mcp__claude-in-chrome__navigate` → `navigate`.
 * The dispatch key for the per-verb render switch. Empty for non-chrome names. */
export const chromeVerb = (name: string): string => {
  const prefix = matchPrefix(name)
  return prefix ? name.slice(prefix.length) : ""
}

/** A readable title for the call header — `chrome.<verb>`, with the internal
 * `_mcp` suffix some tab tools carry (`tabs_create_mcp`) trimmed so the label
 * reads as the action, not the transport. */
export const chromeToolLabel = (name: string): string => `chrome.${chromeVerb(name).replace(/_mcp$/, "")}`
