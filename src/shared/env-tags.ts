/**
 * Environment-variable names Arc stamps onto each launched target CLI so its
 * hook subprocesses self-identify their chat/target session. Hooks run as
 * children of the CLI and inherit its environment, which makes this the
 * deterministic attribution lever — no launch-timing races, no target
 * ambiguity. Ported from arc-prototype's `ArcEnvTags` (Swift); the eventual
 * hook-signal reader must use these same names.
 */
export const ArcEnvTags = {
  chatId: "ARC_CHAT_ID",
  targetSessionId: "ARC_TARGET_SESSION_ID",
  targetProvider: "ARC_TARGET_PROVIDER",
  dbPath: "ARC_DB_PATH",
  mcpToken: "ARC_MCP_TOKEN",
} as const

export const arcMcpBearerToken = (opts: {
  chatId: string
  targetSessionId: string
}): string => `${opts.targetSessionId}:${opts.chatId}`

/** The `ARC_*` assignments to merge into a launched CLI's environment. */
export function arcEnvTags(opts: {
  chatId: string
  targetSessionId: string
  provider: string
  dbPath?: string
}): Record<string, string> {
  const env: Record<string, string> = {
    [ArcEnvTags.chatId]: opts.chatId,
    [ArcEnvTags.targetSessionId]: opts.targetSessionId,
    [ArcEnvTags.targetProvider]: opts.provider,
    [ArcEnvTags.mcpToken]: arcMcpBearerToken(opts),
  }
  if (opts.dbPath) env[ArcEnvTags.dbPath] = opts.dbPath
  return env
}
