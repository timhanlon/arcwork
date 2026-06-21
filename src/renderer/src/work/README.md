# Work rendering

How a unit of authored work gets drawn. **One concept, several surfaces** — the
section-per-folder layout (see repo `CLAUDE.md`) deliberately scatters the
surfaces, so this is the map. Rule of thumb: **compose the atoms below; never
re-derive status/priority logic in a surface.** (That fork is exactly what made
this unreadable once.)

## Atoms — the single source for status/priority presentation

| Atom | File | What |
|------|------|------|
| `isWorkStatus` / `isWorkPriority`, `WORK_STATUSES` / `WORK_PRIORITIES` | `shared/work.ts` | The lists + type guards. **Source of truth** — everything else re-exports these. |
| `WorkStatusMarker` | `work/WorkStatusMarker.tsx` | Leading status icon (check/x/minus for done/blocked/superseded; nothing for open/active). |
| `STATUS_DOT` / `STATUS_ICON` / `STATUS_OPTIONS` / `isResolved` | `work/work-status-display.ts` | Status colour, icon, picker options, the resolved test (drives title dimming). |
| `PriorityChip` / `PrioritySelect` | `work/work-priority-controls.tsx` | Priority chip + editable picker. |
| `PRIORITY_COLOR` | `work/work-priority-display.ts` | Priority chip colour. |

## Surfaces — each composes the atoms into a one-row presentation

Row order and the trailing detail are **per-surface by design** (decided
2026-06-21: no shared `WorkLine`; the contexts differ enough to keep their own
layouts). They share the atoms, not the assembly.

| Surface | File | Row |
|---------|------|-----|
| Sidebar tree leaf | `sidebar/WorkRow.tsx` | marker · title · priority · "mentioned" subtitle |
| Navigator list | `work/WorkListView.tsx` | marker · priority · title · relative time |
| Chat-scoped list | `chat/ChatWork.tsx` | title · marker · relative time |
| Transcript arc card | `chat/tool-calls/arc-tool-body.tsx` (`WorkLine`) | marker · title · status word · priority |

## Detail — the full editable view (one cohesive tree, all in `work/`)

```
WorkPane → WorkDetailView → { WorkDetailHeader, WorkDetailBody / WorkDetailEditor }
                          → { WorkComments, WorkBodyEditor, WorkIdCopy }
```

## Not authored status — don't confuse it

`sidebar/workqueue/WorkQueue.tsx` renders **derived execution state**
(`running` / `needs_attention` / `stale`, a glowing dot), a separate vocabulary
from authored status (`open`…`superseded`). See the note in `shared/work.ts`.

## Comment hygiene

A comment describes **what its own code does**. Don't assert another component's
behaviour ("the sidebar dims…", "arc cards use…") — those claims drift and lie.
Cross-surface facts live here, in this map.
