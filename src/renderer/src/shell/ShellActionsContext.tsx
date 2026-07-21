import { createContext, useContext } from "react"
import type { ArcShellActions } from "./useArcShell.js"

// The shell machine (arcShellMachine) is instantiated once in App via
// useArcShell and its actions used to be prop-drilled to every consumer
// (the work-open action threaded App → UnifiedChatPane → Message →
// ToolCall → …). This context surfaces those actions to any component in the
// tree so leaf renderers dispatch directly instead of receiving a callback through
// half a dozen intermediaries.
//
// The default is an all-no-op set so a component still renders (and stays
// clickable) outside a provider — Storybook, isolated unit renders. `actor` is
// never reached in those contexts, so it throws rather than fabricate a fake one.
const noop = (): void => {}

const DEFAULT_ACTIONS: ArcShellActions = {
  selectChat: noop,
  selectSidebar: noop,
  open: noop,
  closeCenterTab: noop,
  openFilePath: () => false,
  launchTarget: noop,
  bindTarget: noop,
  focusSession: noop,
  focusTarget: noop,
  adoptSession: noop,
  resumeDetached: noop,
  resumeSession: noop,
  ptyExited: noop,
  stopSession: noop,
  focusComposer: noop,
  jumpChatToBottom: noop,
  createWork: noop,
  toggleLeftPanel: noop,
  toggleRightPanel: noop,
  setLeftCollapsed: noop,
  setRightCollapsed: noop,
  get actor(): never {
    throw new Error("useShellActions: no ShellActionsProvider mounted — `actor` is unavailable")
  },
}

const ShellActionsContext = createContext<ArcShellActions>(DEFAULT_ACTIONS)

export const ShellActionsProvider = ShellActionsContext.Provider

/** The shell machine's actions, dispatched without prop-drilling. Safe (no-op)
 * outside a provider. */
export function useShellActions(): ArcShellActions {
  return useContext(ShellActionsContext)
}
