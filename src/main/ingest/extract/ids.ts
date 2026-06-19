import type { Provider } from "../db/schema.js"

/**
 * Deterministic ids so re-ingesting a session produces identical rows and
 * parser changes are easy to diff. Ids are derived from stable native keys
 * (provider + native session id) and per-session sequence numbers.
 */

export const sessionId = (provider: Provider, nativeSessionId: string): string =>
  `${provider}:${nativeSessionId}`

export const messageId = (session: string, sequence: number): string =>
  `${session}:message:${sequence}`

export const toolCallId = (session: string, sequence: number): string =>
  `${session}:tool:${sequence}`

export const fileHintId = (session: string, sequence: number): string =>
  `${session}:hint:${sequence}`

export const diagnosticId = (session: string, sequence: number): string =>
  `${session}:diag:${sequence}`
