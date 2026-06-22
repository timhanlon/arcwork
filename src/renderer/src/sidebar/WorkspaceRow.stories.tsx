import type { ReactNode } from "react"
import { CaretDown } from "@phosphor-icons/react"
import { WorkspaceRow } from "./WorkspaceRow.js"
import { workspace } from "./fixtures.js"
import { DISCLOSURE } from "./row-styles.js"

export default {
  title: "Sidebar / WorkspaceRow",
}

const noop = (): void => {}

/** Static stand-in for the live Collapsible.Trigger so the row reads complete. */
const chevron = (
  <span className={DISCLOSURE} aria-hidden>
    <CaretDown size={12} weight="bold" />
  </span>
)

function Column({ children }: { readonly children: ReactNode }) {
  return <div style={{ width: 252, maxWidth: "100%" }}>{children}</div>
}

/** Resting and selected (accent inset rail), stacked for comparison. */
export const Default = () => (
  <Column>
    <WorkspaceRow
      workspace={workspace({ id: "w1", name: "arc-test", path: "/Users/you/dev/arc-test" })}
      selected={false}
      onSelect={noop}
      disclosure={chevron}
    />
    <WorkspaceRow
      workspace={workspace({ id: "w2", name: "selected", path: "/Users/you/dev/selected" })}
      selected
      onSelect={noop}
      disclosure={chevron}
    />
  </Column>
)

/** A branch with an open PR (right-edge chip) and a draft PR (muted glyph). */
export const WithPullRequest = () => (
  <Column>
    <WorkspaceRow
      workspace={workspace({
        id: "w-pr",
        name: "arc-feat-git",
        path: "/Users/you/.worktrees/arc-feat-git",
        branch: "feat/git",
        isWorktree: true,
        pullRequest: {
          number: 128,
          title: "feat(git): show PR + commits in the git surface",
          state: "open",
          isDraft: false,
          url: "https://github.com/acme/arc/pull/128",
        },
      })}
      selected={false}
      onSelect={noop}
      disclosure={chevron}
    />
    <WorkspaceRow
      workspace={workspace({
        id: "w-pr-draft",
        name: "arc-spike",
        path: "/Users/you/.worktrees/arc-spike",
        branch: "spike/idea",
        isWorktree: true,
        pullRequest: {
          number: 131,
          title: "wip: exploratory spike",
          state: "open",
          isDraft: true,
          url: "https://github.com/acme/arc/pull/131",
        },
      })}
      selected={false}
      onSelect={noop}
      disclosure={chevron}
    />
  </Column>
)

/** A deep path — exercises the subtitle's ellipsis truncation. */
export const LongPath = () => (
  <Column>
    <WorkspaceRow
      workspace={workspace({
        id: "w3",
        name: "compound-engineering",
        path: "/Users/you/dev/aux/src/renderer/src/sidebar/components",
      })}
      selected={false}
      onSelect={noop}
      disclosure={chevron}
    />
  </Column>
)
