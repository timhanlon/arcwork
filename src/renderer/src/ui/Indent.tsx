import type { ComponentProps, JSX } from "react"

/**
 * One nesting step. Wrap a subtree in this to push it in by `--spacing-gutter`
 * (one indent unit, defaulting to the caret width so a child's caret sits under
 * its parent's label — the file-tree ladder).
 *
 * Indentation is opt-in: nothing indents on its own. A section's members stay
 * flush with its header; only a genuine parent → child nesting wraps its
 * children here. That keeps "does this indent?" an explicit, per-use choice.
 *
 * Forwards `role`/`aria-*`/`className` so a nested group can stay one element.
 */
export function Indent({ className, children, ...rest }: ComponentProps<"div">): JSX.Element {
  return (
    <div className={className ? `ml-gutter ${className}` : "ml-gutter"} {...rest}>
      {children}
    </div>
  )
}
