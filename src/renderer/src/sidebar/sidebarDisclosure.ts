import { useCallback, useEffect, useState } from "react"
import { Option, Schema } from "effect"

// Which sidebar nodes the user has expanded/collapsed, kept in localStorage so
// the tree comes back the way it was left instead of re-minimizing on every
// boot. Stored per node kind; an id absent from a kind's record means "use the
// caller's default" (projects/chat-sections default collapsed, workspaces open,
// individual chats auto-open when selected/active). localStorage is per-profile
// (Electron's userData dir is split by profile), so dev and stable stay separate.

const RecordOfBool = Schema.Record(Schema.String, Schema.Boolean)

// Every kind is optional on the wire so adding a new one (e.g. `section`) doesn't
// invalidate a payload written by an older build — the missing kind just decodes
// absent and is filled from EMPTY on load.
const StoredDisclosure = Schema.Struct({
  project: Schema.optional(RecordOfBool),
  workspace: Schema.optional(RecordOfBool),
  chatSection: Schema.optional(RecordOfBool),
  chat: Schema.optional(RecordOfBool),
  // Singleton named sections (e.g. the pinned "Active" group), keyed by a stable
  // string rather than an entity id.
  section: Schema.optional(RecordOfBool),
})

export type DisclosureKind = "project" | "workspace" | "chatSection" | "chat" | "section"
type SidebarDisclosure = Record<DisclosureKind, Record<string, boolean>>

const STORAGE_KEY = "arc.sidebar.disclosure.v1"

// The persisted JSON is untrusted, so it's decoded through the schema: a
// malformed payload yields `None` and we fall back to EMPTY.
const codec = Schema.fromJsonString(StoredDisclosure)
const decode = Schema.decodeUnknownOption(codec)
const encode = Schema.encodeSync(codec)

const EMPTY: SidebarDisclosure = { project: {}, workspace: {}, chatSection: {}, chat: {}, section: {} }

function loadSidebarDisclosure(): SidebarDisclosure {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) return EMPTY
  return Option.match(decode(raw), {
    onNone: () => EMPTY,
    onSome: (stored) => ({
      project: stored.project ?? {},
      workspace: stored.workspace ?? {},
      chatSection: stored.chatSection ?? {},
      chat: stored.chat ?? {},
      section: stored.section ?? {},
    }),
  })
}

function saveSidebarDisclosure(state: SidebarDisclosure): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, encode(state))
  } catch {
    // Best-effort: a full or unavailable store just means no persistence.
  }
}

export interface SidebarDisclosureHandle {
  /** The node's open state, or `fallback` if the user has never toggled it. */
  readonly isOpen: (kind: DisclosureKind, id: string, fallback: boolean) => boolean
  readonly setOpen: (kind: DisclosureKind, id: string, open: boolean) => void
}

export function useSidebarDisclosure(): SidebarDisclosureHandle {
  const [state, setState] = useState<SidebarDisclosure>(loadSidebarDisclosure)

  useEffect(() => {
    saveSidebarDisclosure(state)
  }, [state])

  const isOpen = useCallback(
    (kind: DisclosureKind, id: string, fallback: boolean): boolean => state[kind][id] ?? fallback,
    [state],
  )

  // Stable identity (empty deps + functional update) so callers can list it in
  // effect deps without re-running every render. Bails when the value is already
  // set, which both breaks would-be reveal loops and skips redundant persistence.
  const setOpen = useCallback((kind: DisclosureKind, id: string, open: boolean): void => {
    setState((prev) => {
      if (prev[kind][id] === open) return prev
      return { ...prev, [kind]: { ...prev[kind], [id]: open } }
    })
  }, [])

  return { isOpen, setOpen }
}
