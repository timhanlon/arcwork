import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { Effect } from "effect"
import { ArcEnvTags } from "../../shared/env-tags.js"
import { arcId } from "../../shared/ids.js"
import type { WorkProvenance } from "../../shared/work.js"

/** HTTP headers the per-session stdio proxy stamps on upstream MCP requests.
 * Lowercase keys match Effect's `HttpServerRequest.headers` record shape. */
export const ARC_MCP_SESSION_HEADER = "x-arc-session-id"
export const ARC_MCP_CHAT_HEADER = "x-arc-chat-id"
const BEARER_PREFIX = "Bearer "

export interface ArcMcpProvenanceIds {
  readonly sessionId?: string | undefined
  readonly chatId?: string | undefined
}

/** Read session/chat ids the proxy derived from the launched target's env. */
export const provenanceFromEnv = (): ArcMcpProvenanceIds => ({
  sessionId: process.env[ArcEnvTags.targetSessionId] || undefined,
  chatId: process.env[ArcEnvTags.chatId] || undefined,
})

export const provenanceFromBearerToken = (authorization: string | undefined): ArcMcpProvenanceIds => {
  if (!authorization?.startsWith(BEARER_PREFIX)) return {}
  const [sessionId, chatId] = authorization.slice(BEARER_PREFIX.length).split(":", 2)
  return {
    sessionId: sessionId || undefined,
    chatId: chatId || undefined,
  }
}

/** Parse provenance ids stamped by the stdio proxy onto an HTTP MCP request. */
export const provenanceFromHttpHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
): ArcMcpProvenanceIds =>
  mergeProvenanceIds(
    {
      sessionId: headers[ARC_MCP_SESSION_HEADER] || undefined,
      chatId: headers[ARC_MCP_CHAT_HEADER] || undefined,
    },
    provenanceFromBearerToken(headers["authorization"]),
  )

/** Headers the stdio proxy attaches when forwarding to the in-app HTTP MCP server. */
export const provenanceToProxyHeaders = (
  ids: ArcMcpProvenanceIds,
): Record<string, string> => {
  const headers: Record<string, string> = {}
  if (ids.sessionId) headers[ARC_MCP_SESSION_HEADER] = ids.sessionId
  if (ids.chatId) headers[ARC_MCP_CHAT_HEADER] = ids.chatId
  return headers
}

/** Prefer transport-stamped headers (trusted proxy) over voluntary tool params. */
export const mergeProvenanceIds = (
  fromHeaders: ArcMcpProvenanceIds,
  fromParams: ArcMcpProvenanceIds,
): ArcMcpProvenanceIds => ({
  sessionId: fromHeaders.sessionId ?? fromParams.sessionId,
  chatId: fromHeaders.chatId ?? fromParams.chatId,
})

/** Build work provenance for an MCP write, merging header and param sources. The
 * `chatId` is an env/header-stamped arc id (trusted), branded as it lands. */
export const mcpWriteProvenance = (params: ArcMcpProvenanceIds): WorkProvenance => ({
  source: "mcp",
  ...(params.sessionId ? { sessionId: params.sessionId } : {}),
  ...(params.chatId ? { chatId: arcId("chat", params.chatId) } : {}),
})

/** Read provenance ids from the current HTTP request, if this handler is serving MCP. */
export const readMcpProvenanceHeaders = (): Effect.Effect<ArcMcpProvenanceIds> =>
  Effect.gen(function* () {
    const request = yield* Effect.serviceOption(HttpServerRequest.HttpServerRequest)
    if (request._tag === "None") return {}
    return provenanceFromHttpHeaders(request.value.headers)
  })

/** Trusted header ids win over voluntary `sessionId`/`chatId` tool params. */
export const resolveMcpWriteProvenance = (
  params: ArcMcpProvenanceIds,
): Effect.Effect<WorkProvenance> =>
  Effect.map(readMcpProvenanceHeaders(), (fromHeaders) =>
    mcpWriteProvenance(mergeProvenanceIds(fromHeaders, params)),
  )
