// Parsing of arc MCP tool-call names as they land in ingested transcripts. This
// is pure string logic (no rendering), split out from `arc-tool-body.tsx` so it
// can be unit-tested under the plain-Node test runner.
//
// Each target CLI flattens an `arc.<verb>` MCP tool name its own way, collapsing
// the dots in the tool name to underscores but namespacing the server prefix
// differently. All shapes share the `arc_<verb>` tail (e.g. `arc.work.update` →
// `arc_work_update`):
//   Claude → `mcp__arc__arc_<verb>`                (double-underscore namespacing)
//   Cursor → `mcp_plugin-arc-work-arc_arc_<verb>`  (our plugin server, the
//             orchestrated path: `mcp_plugin-<plugin-name>-<server>_`)
//   Cursor → `mcp_arc_arc_<verb>`                  (a home `~/.cursor/mcp.json`
//             server named "arc" — the manual/legacy path)
//   Codex  → `arc_<verb>`                          (no namespace — server prefix only)
const ARC_NAMESPACE_PREFIXES = ["mcp__arc__", "mcp_plugin-arc-work-arc_", "mcp_arc_"] as const
const ARC_VERB_PREFIX = "arc_"

/** Drop the CLI's MCP namespace (if any), leaving the server-prefixed `arc_<verb>`. */
const stripNamespace = (name: string): string => {
  for (const prefix of ARC_NAMESPACE_PREFIXES) {
    if (name.startsWith(prefix)) return name.slice(prefix.length)
  }
  return name
}

/** True for an arc-toolkit call across Claude/Cursor/Codex name flattening. */
export const isArcTool = (name: string): boolean => stripNamespace(name).startsWith(ARC_VERB_PREFIX)

/** The bare verb after the namespace + server prefix: `arc_work_update` → `work_update`.
 * This is the dispatch key — always the flattened (underscore) form, so the
 * per-verb render switches match whatever the CLI emitted. */
export const arcVerb = (name: string): string => stripNamespace(name).slice(ARC_VERB_PREFIX.length)

/** The flattening collapses an `arc.work.update` tool name to the verb
 * `work_update`, indistinguishable from a genuinely underscore-named verb. For
 * the tools whose public name has a dotted second segment we can't recover that
 * from the wire name, so map the known ones back; every other verb's underscores
 * are real (e.g. the historical `work_comment` / `work_status`, `handoff_report`). */
const CANONICAL_VERB: Readonly<Record<string, string>> = {
  work_create: "work.create",
  work_update: "work.update",
}

/** A readable title for the call header — the tool's public `arc.<verb>` name,
 * with the dotted segment restored for the tools that have one. */
export const arcToolLabel = (name: string): string => {
  const verb = arcVerb(name)
  return `arc.${CANONICAL_VERB[verb] ?? verb}`
}
