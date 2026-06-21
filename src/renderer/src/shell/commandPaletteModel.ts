// The command palette's data model, kept separate from the React component so
// the filtering is unit-testable and the command list can be assembled wherever
// the handlers live (App) without importing the view.

/** A second-stage option for a parameterized command — e.g. one workspace under
 * "New chat in…". `subtitle` is dimmed context (a path, a branch). */
export interface CommandChoice {
  readonly id: string
  readonly title: string
  readonly subtitle?: string
}

/** One palette entry. A leaf command has `run` and fires on select; a
 * parameterized command has `choices` + `onChoose` and opens a second stage to
 * pick a target (the workspace for "New chat in…", later a worktree to launch
 * in). `combo` is the keybinding (see keybindings.ts) shown as chips when set. */
export interface Command {
  readonly id: string
  readonly title: string
  readonly combo?: string
  readonly run?: () => void
  readonly choices?: ReadonlyArray<CommandChoice>
  readonly choosePlaceholder?: string
  readonly onChoose?: (choiceId: string) => void
}

/** Case-insensitive substring match on the title, in declaration order. Empty
 * query returns the list unchanged. */
export const filterByTitle = <T extends { readonly title: string }>(
  items: ReadonlyArray<T>,
  query: string,
): ReadonlyArray<T> => {
  const q = query.trim().toLowerCase()
  if (q === "") return items
  return items.filter((item) => item.title.toLowerCase().includes(q))
}
