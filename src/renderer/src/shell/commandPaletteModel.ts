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

/** One palette entry, in one of three shapes:
 * - leaf: `run` fires on select;
 * - pick: opens a second stage to choose a target (static `choices`, or a
 *   `loadChoices` thunk resolved on entry), then calls `onChoose` with its id;
 * - prompt: opens a second stage to type a value (`promptPlaceholder`), then
 *   calls `onSubmit` with the trimmed text — for naming a new worktree branch.
 * `combo` is the keybinding (see keybindings.ts) shown as chips when set. */
export interface Command {
  readonly id: string
  readonly title: string
  readonly combo?: string
  readonly run?: () => void
  readonly choices?: ReadonlyArray<CommandChoice>
  readonly loadChoices?: () => Promise<ReadonlyArray<CommandChoice>>
  readonly choosePlaceholder?: string
  readonly onChoose?: (choiceId: string) => void
  readonly promptPlaceholder?: string
  readonly onSubmit?: (value: string) => void
}

/** True when selecting `command` opens a target-picking second stage. */
export const isParameterized = (command: Command): boolean =>
  command.choices !== undefined || command.loadChoices !== undefined

/** True when selecting `command` opens a free-text second stage. */
export const isPrompt = (command: Command): boolean => command.onSubmit !== undefined

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
