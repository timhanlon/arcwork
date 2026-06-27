import * as HttpServerRequest from "effect/unstable/http/HttpServerRequest"
import { Effect } from "effect"
import { arcId } from "../../shared/ids.js"
import type { WorkProvenance } from "../../shared/work.js"

/** Bearer-less fallback headers carrying Arc provenance ids on an HTTP MCP
 * request. Lowercase keys match Effect's `HttpServerRequest.headers` record
 * shape. They are validated as well-formed TypeIDs at read time and the
 * authenticated bearer always wins over them (see provenanceFromHttpHeaders). */
export const ARC_MCP_SESSION_HEADER = "x-arc-session-id"
export const ARC_MCP_CHAT_HEADER = "x-arc-chat-id"
const BEARER_PREFIX = "Bearer "

export interface ArcMcpProvenanceIds {
  readonly sessionId?: string | undefined
  readonly chatId?: string | undefined
}

/** A bearer segment is trusted only if it's a well-formed TypeID for its prefix.
 * Mirrors `ArcId`'s own suffix pattern (26 Crockford-base32 chars). This is the
 * guard that keeps an un-interpolated placeholder bearer (e.g. Cursor shipping
 * the literal `${env:ARC_MCP_TOKEN}`, which splits into `${env` / `ARC_MCP_TOKEN}`)
 * from being stamped as session/chat provenance and crashing write encoding. */
const TYPEID_SUFFIX = "[0-9a-hjkmnp-tv-z]{26}"
const wellFormedArcId = (prefix: string, value: string | undefined): string | undefined =>
  value && new RegExp(`^${prefix}_${TYPEID_SUFFIX}$`).test(value) ? value : undefined

export const provenanceFromBearerToken = (authorization: string | undefined): ArcMcpProvenanceIds => {
  if (!authorization?.startsWith(BEARER_PREFIX)) return {}
  const [sessionId, chatId] = authorization.slice(BEARER_PREFIX.length).split(":", 2)
  return {
    sessionId: wellFormedArcId("target", sessionId),
    chatId: wellFormedArcId("chat", chatId),
  }
}

/**
 * Resolve provenance for an HTTP MCP request from the two live sources. The
 * `Authorization: Bearer target:chat` token is the authenticated, Arc-baked
 * identity; the `x-arc-*` headers are an unauthenticated fallback for bearer-less
 * clients. So the BEARER WINS when present — a direct caller can't override its
 * own identity by also sending an `x-arc-session-id`/`x-arc-chat-id` for another
 * target (which would otherwise let it read that target's assignment via
 * `arc.prime`). Both header ids are validated as well-formed TypeIDs, so a forged
 * or malformed header on the bearer-less path can't poison provenance.
 */
export const provenanceFromHttpHeaders = (
  headers: Readonly<Record<string, string | undefined>>,
): ArcMcpProvenanceIds =>
  mergeProvenanceIds(provenanceFromBearerToken(headers["authorization"]), {
    sessionId: wellFormedArcId("target", headers[ARC_MCP_SESSION_HEADER] || undefined),
    chatId: wellFormedArcId("chat", headers[ARC_MCP_CHAT_HEADER] || undefined),
  })

/** Prefer transport-derived ids (bearer / validated headers) over voluntary tool params. */
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
