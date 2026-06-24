import { Option, Schema } from "effect"
import { PersistedShellSelection, type ShellSelection } from "./arcShellMachine.js"

// Last open workspace/chat, kept in localStorage so a restart lands the center
// pane where the user left it instead of always defaulting to the first chat.
// localStorage is per-profile (Electron's userData dir is split by profile), so
// dev and stable stay separate. The stored JSON is untrusted, so it's decoded
// through the schema: a malformed or stale-shaped payload yields `None` and we
// fall back to an empty selection rather than casting blindly.

const STORAGE_KEY = "arc.shell.selection.v1"

const codec = Schema.fromJsonString(PersistedShellSelection)
const decode = Schema.decodeUnknownOption(codec)
const encode = Schema.encodeSync(codec)

const EMPTY: PersistedShellSelection = { chatByWorkspace: {} }

export function loadPersistedSelection(): PersistedShellSelection {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) return EMPTY
  return Option.getOrElse(decode(raw), () => EMPTY)
}

export function savePersistedSelection(selection: ShellSelection): void {
  const payload: PersistedShellSelection = {
    workspaceId: selection.workspaceId,
    chatId: selection.chatId,
    chatByWorkspace: selection.chatByWorkspace,
  }
  try {
    window.localStorage.setItem(STORAGE_KEY, encode(payload))
  } catch {
    // Best-effort: a full or unavailable store just means no persistence.
  }
}
