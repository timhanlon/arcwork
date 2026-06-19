import { useEffect } from "react"
import { keybindings, matchesCombo, type GlobalCommandId } from "./keybindings.js"

type CommandHandlers = Readonly<Record<GlobalCommandId, () => void>>

/** True when the keystroke is destined for an editable field's own caret. */
const isEditableTarget = (event: KeyboardEvent): boolean => {
  const target = event.target
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA"
}

/**
 * Installs the renderer's global keyboard shortcuts (see `keybindings.ts`).
 * Bindings dispatch to `handlers` keyed by command id. `handlers` is read from
 * a ref each keydown, so callers can pass a fresh object every render without
 * re-subscribing the listener.
 */
export function useKeyboardShortcuts(handlers: CommandHandlers): void {
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      for (const binding of keybindings) {
        if (matchesCombo(event, binding.combo)) {
          // A caret key (⌘↓ / End) pressed inside a text field belongs to that
          // field — let the browser run its default instead of stealing it.
          if (binding.skipInTextInput && isEditableTarget(event)) return
          event.preventDefault()
          handlers[binding.id]()
          return
        }
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [handlers])
}
