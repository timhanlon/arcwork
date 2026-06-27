import { rpc } from "../rpc-client.js"
import { arcId, type WorkspaceId } from "../../../shared/ids.js"
import type { Workspace } from "../../../shared/workspace.js"
import { bindingFor, type GlobalCommandId } from "./keybindings.js"
import type { Command } from "./commandPaletteModel.js"

export interface PaletteCommandsInput {
  /** The active workspace (the worktree commands act on it, so they only appear
   * when one is selected). */
  readonly workspaceId: WorkspaceId | undefined
  readonly workspacePath: string | undefined
  readonly workspaces: ReadonlyArray<Workspace>
  readonly createChat: (workspaceId: WorkspaceId) => Promise<void>
  /** The ⌘-shortcut handler map; leaf commands reuse a handler + borrow its
   * combo for the on-row hint. */
  readonly shortcutHandlers: Record<GlobalCommandId, () => void>
}

/**
 * Build the ⌘K palette command list. A plain builder (no React state), lifted
 * out of App so the layout component stays atoms→layout wiring: App computes the
 * shortcut handlers (which need its shell actions) and the active-workspace bits,
 * and hands them here. Rebuilt each render like the inline version it replaces;
 * the palette only reads it when open.
 */
export const buildPaletteCommands = ({
  workspaceId,
  workspacePath,
  workspaces,
  createChat,
  shortcutHandlers,
}: PaletteCommandsInput): ReadonlyArray<Command> => {
  // Open a worktree as a workspace (minting its row if needed), then start a
  // chat in it — for a worktree that already exists.
  const openWorktreeChat = async (worktreePath: string): Promise<void> => {
    const workspace = await rpc("OpenWorktree", { worktreePath })
    await createChat(workspace.id)
  }

  // Branch a fresh worktree off the repo's default branch, open it, and chat in
  // it — the "start a new isolated line of work" path. baseRef is omitted, so
  // the main side defaults it to the repo's default branch.
  const newWorktreeChat = async (branch: string, carryChanges = false): Promise<void> => {
    if (!workspaceId) return
    const worktree = await rpc("CreateWorktree", {
      workspaceId,
      branch,
      createBranch: true,
      carryChanges,
    })
    await openWorktreeChat(worktree.path)
  }

  const removeWorktree = async (worktreePath: string): Promise<void> => {
    if (!workspaceId) return
    await rpc("RemoveWorktree", { workspaceId, worktreePath })
  }

  // Leaf commands reuse the shortcut handlers (and borrow their combo for the
  // on-row hint).
  const leafCommand = (id: GlobalCommandId, title: string): Command => ({
    id,
    title,
    combo: bindingFor(id)?.combo,
    run: shortcutHandlers[id],
  })

  const loadRemovableWorktreeChoices = async () => {
    if (!workspaceId) return []
    const context = await rpc("GetWorkspaceGitContext", { workspaceId })
    const mainPath = context.repository?.rootPath
    // Exclude the main worktree (never removable) and the one we're viewing —
    // removing the active workspace would archive it out from under the session.
    // Identify the active worktree by branch (as createWorktree does), not path:
    // git reports symlink-resolved paths that needn't match the workspace's
    // stored path on macOS; the stored path is kept only as a secondary guard.
    const activeBranch = context.branch
    return context.worktrees
      .filter(
        (worktree) =>
          worktree.path !== mainPath &&
          worktree.path !== workspacePath &&
          (activeBranch == null || worktree.branch !== activeBranch),
      )
      .map((worktree) => ({
        id: worktree.path,
        title: worktree.branch ?? (worktree.path.split("/").pop() ?? worktree.path),
        subtitle: worktree.path,
      }))
  }

  const worktreeCommands: ReadonlyArray<Command> = workspaceId
    ? [
        {
          id: "newWorktree",
          title: "New worktree…",
          promptPlaceholder: "new branch name",
          onSubmit: (branch) => void newWorktreeChat(branch),
        },
        {
          id: "newWorktreeWithChanges",
          title: "New worktree with current changes…",
          promptPlaceholder: "new branch name",
          onSubmit: (branch) => void newWorktreeChat(branch, true),
        },
        {
          id: "openWorktree",
          title: "Open worktree…",
          choosePlaceholder: "choose a worktree",
          loadChoices: async () => {
            if (!workspaceId) return []
            const context = await rpc("GetWorkspaceGitContext", { workspaceId })
            return context.worktrees.map((worktree) => ({
              id: worktree.path,
              title: worktree.branch ?? (worktree.path.split("/").pop() ?? worktree.path),
              subtitle: worktree.path,
            }))
          },
          onChoose: (worktreePath) => void openWorktreeChat(worktreePath),
        },
        {
          id: "removeWorktree",
          title: "Remove Git worktree…",
          choosePlaceholder: "choose a Git worktree to remove",
          loadChoices: loadRemovableWorktreeChoices,
          onChoose: (worktreePath) => void removeWorktree(worktreePath),
        },
      ]
    : []

  // "New chat in workspace…" opens a second stage over the open workspaces and
  // lands the chat in the chosen one.
  return [
    {
      id: "newChatInWorkspace",
      title: "New chat in workspace…",
      choosePlaceholder: "choose a workspace",
      choices: workspaces.map((w) => ({ id: w.id, title: w.name, subtitle: w.path })),
      onChoose: (workspaceId) => void createChat(arcId("workspace", workspaceId)),
    },
    ...worktreeCommands,
    leafCommand("createChat", "New chat"),
    leafCommand("createWork", "New work item"),
    leafCommand("showChatView", "Show chat"),
    leafCommand("showWorkView", "Show work"),
    leafCommand("showTerminalView", "Show terminal"),
    leafCommand("showGitView", "Show git"),
    leafCommand("toggleLeftPanel", "Toggle left panel"),
    leafCommand("toggleRightPanel", "Toggle right panel"),
    leafCommand("openSearchPalette", "Search…"),
  ]
}
