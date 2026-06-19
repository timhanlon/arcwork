import type { JSX } from "react"
import { SESSION_DOT, SESSION_DOT_DETACHED, type SessionDisplayStatus } from "./row-styles.js"

/**
 * The leading status dot on a session row — the sidebar's core status vocabulary
 * in one glyph. Live states fill with their tone; "active" adds a halo; any
 * unknown/"detached" status falls back to the quiet hollow ring.
 */
export function SessionDot({ status }: { readonly status: SessionDisplayStatus }): JSX.Element {
  return (
    <span
      className={`size-1.5 flex-none rounded-full ${SESSION_DOT[status] ?? SESSION_DOT_DETACHED}`}
      aria-hidden
    />
  )
}
