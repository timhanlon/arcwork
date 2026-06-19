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
