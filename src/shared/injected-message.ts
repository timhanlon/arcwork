import { arcId, type TargetId } from "./ids.js"

/**
 * The attribution header prepended to a message injected into a target session's
 * PTY by `arc.agent.send` (a spawned child reporting to its parent, a peer, a
 * user nudge from another agent).
 *
 * Delivery is a PTY paste, so the message lands in the provider's transcript as a
 * plain `role: user` turn — every provider treats stdin as the user, with no
 * third sender channel. This header is the one carrier that survives into every
 * provider's transcript uniformly, so Arc's chat projection reads it back to
 * re-attribute the turn to its real sender instead of drawing it as the human
 * user (see {@link parseInjectedMarker}).
 *
 * The sender id is authoritative: only Arc emits this header, stamped from the
 * durable `target_messages.sender_target_session_id` (the calling agent's MCP
 * provenance), never from the model's free-text `from`. The header doubles as the
 * receiving model's only inline signal that the turn came from another agent.
 */
const MARKER_RE =
  /^\u{1F4E8} \[arc:from=(target_[0-9a-hjkmnp-tv-z]{26})(?: msg=(inbox_[0-9a-hjkmnp-tv-z]{26}))?\][^\n]*\n+/u

export interface InjectedAttribution {
  readonly senderTargetSessionId: TargetId
  /** the originating `target_messages` (inbox) row — the correlation key
   * projection verifies against the delivered record before re-attributing (the
   * head inbox row id for a batched delivery); null only when the marker carried
   * no `msg=` segment. */
  readonly targetMessageId: string | null
  /** the message body with the attribution header stripped */
  readonly body: string
}

/**
 * Build the text pasted for an injected message: a parseable header carrying the
 * machine-readable sender id and the inbox row id, plus a human label the
 * receiving model reads as "this is from agent X", followed by the body.
 *
 * Pass `targetMessageId` — projection verifies the marker against the delivered
 * inbox row *by this id* before re-attributing, so omitting it produces a marker
 * that parses but is never attributed (the turn renders verbatim with the raw
 * marker text). The production path always supplies it.
 */
export const withInjectedMarker = (
  senderTargetSessionId: TargetId,
  senderLabel: string,
  body: string,
  targetMessageId?: string,
): string => {
  const msg = targetMessageId ? ` msg=${targetMessageId}` : ""
  return `\u{1F4E8} [arc:from=${senderTargetSessionId}${msg}] ${senderLabel} says:\n\n${body}`
}

/**
 * Parse the attribution header off an injected paste, returning the real sender
 * (and inbox breadcrumb) plus the body with the header stripped — or null for an
 * ordinary (human) user turn that carries no marker.
 */
export const parseInjectedMarker = (text: string): InjectedAttribution | null => {
  const match = MARKER_RE.exec(text)
  if (!match) return null
  return {
    senderTargetSessionId: arcId("target", match[1]!),
    targetMessageId: match[2] ?? null,
    body: text.slice(match[0].length),
  }
}
