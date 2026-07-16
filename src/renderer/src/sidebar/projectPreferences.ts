import { Option, Schema } from "effect"
import { useCallback, useEffect, useMemo, useState } from "react"
import type { ProjectGroup } from "./grouping.js"

/** The user's project-specific sidebar choices. Project keys are repository ids
 * (or workspace ids for plain folders), so a preference naturally follows a
 * repository across its worktrees. */
export interface ProjectPreferences {
  readonly pinned: ReadonlyArray<string>
  readonly order: ReadonlyArray<string>
}

const StoredProjectPreferences = Schema.Struct({
  pinned: Schema.optional(Schema.Array(Schema.String)),
  order: Schema.optional(Schema.Array(Schema.String)),
})

const STORAGE_KEY = "arc.sidebar.projects.v1"
const EMPTY: ProjectPreferences = { pinned: [], order: [] }
const codec = Schema.fromJsonString(StoredProjectPreferences)
const decode = Schema.decodeUnknownOption(codec)
const encode = Schema.encodeSync(codec)

function unique(values: ReadonlyArray<string>): ReadonlyArray<string> {
  return [...new Set(values)]
}

function loadProjectPreferences(): ProjectPreferences {
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (raw === null) return EMPTY
  return Option.match(decode(raw), {
    onNone: () => EMPTY,
    onSome: (stored) => ({ pinned: unique(stored.pinned ?? []), order: unique(stored.order ?? []) }),
  })
}

function saveProjectPreferences(preferences: ProjectPreferences): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, encode(preferences))
  } catch {
    // Best-effort: an unavailable store only loses sidebar customisation.
  }
}

/** Sort pinned projects first, then respect the user's drag order. New projects
 * retain their server order until the user moves them. */
export function orderProjects(
  projects: ReadonlyArray<ProjectGroup>,
  preferences: ProjectPreferences,
): ReadonlyArray<ProjectGroup> {
  const rank = new Map(preferences.order.map((key, index) => [key, index]))
  const pinned = new Set(preferences.pinned)
  return projects
    .map((project, index) => ({ project, index }))
    .sort((a, b) => {
      const pinOrder = Number(pinned.has(b.project.key)) - Number(pinned.has(a.project.key))
      if (pinOrder !== 0) return pinOrder
      return (rank.get(a.project.key) ?? Number.MAX_SAFE_INTEGER) - (rank.get(b.project.key) ?? Number.MAX_SAFE_INTEGER) || a.index - b.index
    })
    .map(({ project }) => project)
}

/** Move one project key before another, preserving unrelated saved ranks. */
export function moveProject(
  currentOrder: ReadonlyArray<string>,
  sourceKey: string,
  targetKey: string,
): ReadonlyArray<string> {
  if (sourceKey === targetKey) return currentOrder
  const order = currentOrder.filter((key) => key !== sourceKey)
  const targetIndex = order.indexOf(targetKey)
  if (targetIndex === -1) return [...order, sourceKey]
  order.splice(targetIndex, 0, sourceKey)
  return order
}

export interface ProjectPreferencesHandle {
  readonly pinned: ReadonlySet<string>
  readonly order: ReadonlyArray<string>
  readonly togglePinned: (key: string) => void
  /** `visibleOrder` keeps a first drag faithful even for projects never saved before. */
  readonly move: (sourceKey: string, targetKey: string, visibleOrder: ReadonlyArray<string>) => void
}

export function useProjectPreferences(): ProjectPreferencesHandle {
  const [preferences, setPreferences] = useState<ProjectPreferences>(loadProjectPreferences)
  useEffect(() => saveProjectPreferences(preferences), [preferences])

  const togglePinned = useCallback((key: string): void => {
    setPreferences((previous) => ({
      ...previous,
      pinned: previous.pinned.includes(key)
        ? previous.pinned.filter((pinnedKey) => pinnedKey !== key)
        : [...previous.pinned, key],
    }))
  }, [])
  const move = useCallback((sourceKey: string, targetKey: string, visibleOrder: ReadonlyArray<string>): void => {
    setPreferences((previous) => ({ ...previous, order: moveProject(visibleOrder, sourceKey, targetKey) }))
  }, [])

  return useMemo(
    () => ({ pinned: new Set(preferences.pinned), order: preferences.order, togglePinned, move }),
    [preferences.pinned, preferences.order, togglePinned, move],
  )
}
