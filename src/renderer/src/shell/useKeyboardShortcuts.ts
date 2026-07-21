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
    // Monaco consumes several modifier chords during bubbling (including ⌘K),
    // so global Arc commands listen in capture phase before the editor can stop
    // propagation. Local editor commands remain untouched because this handler
    // only prevents defaults for bindings in the global registry.
    window.addEventListener("keydown", onKeyDown, true)
    return () => window.removeEventListener("keydown", onKeyDown, true)
  }, [handlers])
}
