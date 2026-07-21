// Central registry of renderer keyboard shortcuts. Definitions live here (one
// place) so a future settings surface can rebind them without hunting through
// components — configurable bindings are a stated north star for the composer.
//
// A `combo` is a "+"-joined list of lowercase tokens: the modifiers `mod`
// (⌘ on macOS, Ctrl elsewhere), `ctrl`, `alt`, `shift`, plus one non-modifier
// key matched against `KeyboardEvent.key` (case-insensitive, e.g. "b", "/").

/** ⌘1…⌘9 jump to the Nth target session waiting on the user (1-based). */
export type RequestSlot = 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9
export const REQUEST_SLOTS: ReadonlyArray<RequestSlot> = [1, 2, 3, 4, 5, 6, 7, 8, 9]

/**
 * Commands dispatched by the global `useKeyboardShortcuts` listener — they fire
 * from anywhere in the window. Every one needs a handler in App's shortcut map.
 */
export type GlobalCommandId =
  | "toggleLeftPanel"
  | "toggleRightPanel"
  | "showChatView"
  | "showWorkView"
  | "closeCenterTab"
  | "createChat"
  | "createWork"
  | "showTerminalView"
  | "showGitView"
  | "focusComposer"
  | "jumpToChatBottom"
  | "resumeDetachedSession"
  | "openSearchPalette"
  | "openCommandPalette"
  | `focusRequest${RequestSlot}`

/**
 * Commands owned by a specific component, not the global listener — `sendMessage`
 * only fires inside the composer (and not while the reference picker is open),
 * `submitWorkCreate` only inside the new-work form. They still live in the
 * registry so their combo is the single source of truth for both the local
 * handler (via {@link matchesCombo}) and the on-screen hint (via {@link bindingFor}).
 */
export type LocalCommandId = "sendMessage" | "submitWorkCreate" | "cancelWorkEdit" | "saveWorkRevision"

export type ShellCommandId = GlobalCommandId | LocalCommandId

export const focusRequestId = (slot: RequestSlot): GlobalCommandId => `focusRequest${slot}`

/**
 * The character that opens the composer's reference picker (`@` work / file /
 * session). It lives here, in the rebindable home, because which key triggers
 * references is contested: CLI users expect `@` to mean a *file*, chat users
 * expect it to mean a *mention*. arc's `@` is a unified picker over every target
 * kind (files included), so it serves both — but anyone who wants `@` to stay
 * literal can repoint this to `#` or another sigil without touching the composer.
 * Single-character only (it's matched against typed input, not a modifier chord).
 */
export const REFERENCE_TRIGGER = "@"

export interface Keybinding<Id extends ShellCommandId = ShellCommandId> {
  readonly id: Id
  readonly combo: string
  /** Human-readable accelerator for tooltips, e.g. "⌘B" / "Ctrl+B". */
  readonly label: string
  /**
   * When true, the binding yields to the browser if an editable element (input /
   * textarea / contenteditable) has focus, so its native caret behaviour wins.
   * Only set on bindings whose key is itself a text-editing key — ⌘↓ / End move
   * the caret to the end of the field, and hijacking them globally would break
   * editing in the composer. Modifier-chord bindings (⌘B, ⌘L…) don't need this.
   */
  readonly skipInTextInput?: boolean
}

export const isMac =
  typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac")

const accel = (combo: string): string => {
  const parts = combo.split("+")
  const key = parts[parts.length - 1] ?? ""
  const mods = parts.slice(0, -1)
  const glyph = (token: string): string => {
    switch (token) {
      case "mod":
        return isMac ? "⌘" : "Ctrl+"
      case "ctrl":
        return isMac ? "⌃" : "Ctrl+"
      case "alt":
        return isMac ? "⌥" : "Alt+"
      case "shift":
        return isMac ? "⇧" : "Shift+"
      default:
        return token
    }
  }
  // Non-letter keys (arrows, End, Enter) read better as glyphs/words than uppercased.
  const keyLabel = (token: string): string => {
    switch (token) {
      case "arrowdown":
        return "↓"
      case "arrowup":
        return "↑"
      case "end":
        return "End"
      case "escape":
        return "Esc"
      case "enter":
        return "⏎"
      default:
        return token.toUpperCase()
    }
  }
  return mods.map(glyph).join("") + keyLabel(key)
}

const binding = <Id extends ShellCommandId>(
  id: Id,
  combo: string,
  options?: { readonly skipInTextInput?: boolean },
): Keybinding<Id> => ({
  id,
  combo,
  label: accel(combo),
  ...(options?.skipInTextInput ? { skipInTextInput: true } : {}),
})

export const keybindings: ReadonlyArray<Keybinding<GlobalCommandId>> = [
  // Mirrors VS Code / Cursor: ⌘B toggles the primary (left) sidebar,
  // ⌘⌥B toggles the secondary (right) panel.
  binding("toggleLeftPanel", "mod+b"),
  binding("toggleRightPanel", "mod+alt+b"),
  // ⌘⇧C / ⌘⇧W switch the center pane between the chat and work views (the
  // segmented control in the nav bar). Each destination is named rather than
  // toggled blind, leaving room for a third center view later.
  binding("showChatView", "mod+shift+c"),
  binding("showWorkView", "mod+shift+w"),
  binding("closeCenterTab", "mod+w"),
  // new-chat / new-work: each surfaces its view and opens a fresh item from
  // anywhere — the keyboard twins of the sidebar's "+ chat" and the work list's
  // "+ new work" buttons. The combos below are defaults; they're rebindable.
  binding("createChat", "mod+n"),
  binding("createWork", "mod+shift+n"),
  // ⌘⇧T / ⌘⇧G switch the right panel between the terminal and git views (the
  // segmented control on the right side of the nav bar).
  binding("showTerminalView", "mod+shift+t"),
  binding("showGitView", "mod+shift+g"),
  // ⌘L drops the cursor into the composer from anywhere (mirrors Cursor's
  // jump-to-chat-input). It surfaces the chat view first if the center was
  // showing work/git, so the composer is always there to receive focus. Esc
  // inside the composer releases it back to the shell (handled in ChatComposer).
  binding("focusComposer", "mod+l"),
  // Jump the chat transcript to the latest message. ⌘↓ mirrors macOS's native
  // "move to end of document"; End is the cross-platform scroll-to-bottom. Both
  // are caret keys inside the composer, so they're flagged to yield there (see
  // `skipInTextInput`). Two bindings, one command — same handler fires for each.
  binding("jumpToChatBottom", "mod+arrowdown", { skipInTextInput: true }),
  binding("jumpToChatBottom", "end", { skipInTextInput: true }),
  // ⌘⇧P re-attaches a restored-but-detached target — the keyboard twin of the
  // terminal pane's play/resume button (hence P, not R: Electron's default menu
  // already owns ⌘R / ⌘⇧R for reload). A no-op unless a resumable session is
  // parked.
  binding("resumeDetachedSession", "mod+shift+p"),
  // ⌘⇧F opens the unified Arc search command palette.
  binding("openSearchPalette", "mod+shift+f"),
  // ⌘K opens the command palette — run any command, or pick a target (the
  // workspace for "new chat in…", a worktree to launch in).
  binding("openCommandPalette", "mod+k"),
  // ⌘1…⌘9 jump straight to the Nth session waiting for the user, counted in the
  // sidebar's top-to-bottom order. The matching number shows on each pending row.
  ...REQUEST_SLOTS.map((slot) => binding(focusRequestId(slot), `mod+${slot}`)),
]

/**
 * Bindings handled by their owning component rather than the global listener (see
 * {@link LocalCommandId}). Kept out of `keybindings` so the global keydown loop
 * never fires them — Shift+Enter must mean "send" only inside the composer, not
 * window-wide — yet still resolvable through {@link bindingFor} for hints.
 */
export const localKeybindings: ReadonlyArray<Keybinding<LocalCommandId>> = [
  // Shift+Enter sends the composer draft (plain Enter inserts a newline / picks a
  // reference). Hint: composer footer. Handler: ChatComposer.
  binding("sendMessage", "shift+enter"),
  // ⌘↵ / Ctrl+↵ submits the new-work form from the title field. Handler: WorkCreateForm.
  binding("submitWorkCreate", "mod+enter"),
  // Esc discards the work-detail edit, ⌘S / Ctrl+S saves the revision. They fire
  // from anywhere inside the editor (title, body, labels), not window-wide, so
  // they stay local. Handler: WorkDetailEditor.
  binding("cancelWorkEdit", "escape"),
  binding("saveWorkRevision", "mod+s"),
]

export const bindingFor = (id: ShellCommandId): Keybinding | undefined =>
  keybindings.find((b) => b.id === id) ?? localKeybindings.find((b) => b.id === id)

/**
 * The combo for a statically-known command. Throws at module load if the id is
 * unregistered — use this (not `bindingFor(id)?.combo ?? "literal"`) where the
 * binding is guaranteed to exist, so a misconfigured registry fails loud instead
 * of silently falling back to a stale hardcoded key.
 */
export const comboFor = (id: ShellCommandId): string => {
  const found = bindingFor(id)
  if (!found) throw new Error(`No keybinding registered for "${id}"`)
  return found.combo
}

// The physical `KeyboardEvent.code` for a combo's letter/digit token, or
// undefined for symbols we can't map. macOS composes ⌥+letter into a glyph
// (⌥B → "∫"), so `event.key` is unreliable whenever `alt` is in the combo;
// `event.code` ignores modifiers and layout ("KeyB" stays "KeyB"), so we match
// on it for letters and digits and keep `event.key` as the fallback.
const physicalCode = (key: string): string | undefined => {
  if (/^[a-z]$/.test(key)) return `Key${key.toUpperCase()}`
  if (/^[0-9]$/.test(key)) return `Digit${key}`
  return undefined
}

/** True when `event` matches `combo` exactly (modifier set and key both). */
export function matchesCombo(event: KeyboardEvent, combo: string): boolean {
  const parts = combo.split("+")
  const key = (parts[parts.length - 1] ?? "").toLowerCase()
  const mods = new Set(parts.slice(0, -1))

  // `mod` resolves to ⌘ on macOS and Ctrl elsewhere; `ctrl` is always literal
  // Control. Every modifier not named must be absent, so we compare the full
  // set exactly rather than just checking the ones we want.
  const wantMeta = isMac && mods.has("mod")
  const wantCtrl = mods.has("ctrl") || (!isMac && mods.has("mod"))

  // Match the physical key first so ⌥-combos work despite key composition; fall
  // back to `event.key` for symbol tokens that have no `code` mapping.
  const code = physicalCode(key)
  const keyMatches =
    code !== undefined ? event.code === code : event.key.toLowerCase() === key

  return (
    event.metaKey === wantMeta &&
    event.ctrlKey === wantCtrl &&
    event.altKey === mods.has("alt") &&
    event.shiftKey === mods.has("shift") &&
    keyMatches
  )
}
