import { CommandPalette } from "./CommandPalette.js"
import type { Command } from "./commandPaletteModel.js"

export default {
  title: "Shell / CommandPalette",
}

const noop = (): void => {}

const workspaceChoices = [
  { id: "ws_arc", title: "arc", subtitle: "~/dev/aux" },
  { id: "ws_arc_feat", title: "arc · feat/git", subtitle: "~/.worktrees/arc-feat-git" },
  { id: "ws_site", title: "timhanlon.com", subtitle: "~/dev/site" },
  { id: "ws_notes", title: "notes", subtitle: "~/notes (no repo)" },
]

const commands: ReadonlyArray<Command> = [
  {
    id: "newChatInWorkspace",
    title: "New chat in workspace…",
    choices: workspaceChoices,
    choosePlaceholder: "choose a workspace",
    onChoose: noop,
  },
  { id: "createChat", title: "New chat", combo: "mod+n", run: noop },
  { id: "createWork", title: "New work item", combo: "mod+shift+n", run: noop },
  { id: "showGitView", title: "Show git", combo: "mod+shift+g", run: noop },
  { id: "showTerminalView", title: "Show terminal", combo: "mod+shift+t", run: noop },
  { id: "toggleLeftPanel", title: "Toggle left panel", combo: "mod+b", run: noop },
]

/** Top-level command list. Arrow keys move, Enter selects, typing filters. A
 * row with a "›" opens a second stage. */
export const Default = () => <CommandPalette commands={commands} onClose={noop} />

/** Only the parameterized command, to show the second stage: select "New chat
 * in workspace…" and the list becomes the workspaces (title + dimmed path). */
export const WorkspacePicker = () => (
  <CommandPalette commands={[commands[0]!]} onClose={noop} />
)
