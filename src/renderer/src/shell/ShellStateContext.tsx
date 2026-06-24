import { createContext, useContext } from "react"
import { initialArcShellContext, type ArcShellContext } from "./arcShellMachine.js"

// The shell machine's *state* (selection, layout, panes), surfaced to the tree
// the same way {@link ShellActionsProvider} surfaces its actions — so a deep
// consumer (the sidebar) reads selection from context instead of receiving it as
// a prop threaded down from App. App owns the single `useArcShell` instance and
// provides its `state` here.
//
// The default is the machine's initial context, so a component still renders
// (showing the empty/first-run selection) outside a provider — Storybook stories
// that supply their own seeded shell, isolated unit renders.
const ShellStateContext = createContext<ArcShellContext>(initialArcShellContext)

export const ShellStateProvider = ShellStateContext.Provider

/** The shell machine's current state, read without prop-drilling. Falls back to
 * the initial context outside a provider. */
export function useShellState(): ArcShellContext {
  return useContext(ShellStateContext)
}
