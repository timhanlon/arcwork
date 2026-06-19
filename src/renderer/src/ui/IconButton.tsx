import { Button as BaseButton } from "@base-ui/react/button"
import type { ComponentProps, JSX, ReactNode } from "react"

export interface IconButtonProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  /** A single icon element (e.g. a Phosphor icon). Sized by the button. */
  readonly children: ReactNode
  /** Renders the accent treatment to signal an on/active toggle state. */
  readonly active?: boolean
  readonly className?: string
}

/**
 * The square-glyph skeleton (size, centring, focus reset) and its resting tone,
 * exported so chrome-free toggles built on base-ui's Toggle — e.g.
 * {@link ViewToggleCompact} — can read like an IconButton without a second copy
 * of the recipe drifting out of sync.
 */
export const ICON_BUTTON_BASE =
  "inline-flex items-center justify-center size-7 rounded-[var(--radius)] border border-transparent bg-transparent cursor-pointer outline-none focus-visible:outline-none disabled:opacity-40 disabled:cursor-default [&>svg]:size-4"

export const ICON_BUTTON_REST =
  "text-fg-dim enabled:hover:text-foreground enabled:hover:border-border-strong focus-visible:border-border-strong focus-visible:text-foreground"

const ACTIVE = "text-accent border-transparent"

/**
 * A square, icon-only button — the companion to {@link Button} for toolbar and
 * affordance glyphs. Pass `active` for toggle controls that have an on state.
 */
export function IconButton({ children, active = false, className, ...rest }: IconButtonProps): JSX.Element {
  const cls = [ICON_BUTTON_BASE, active ? ACTIVE : ICON_BUTTON_REST, className].filter(Boolean).join(" ")
  return (
    <BaseButton className={cls} {...rest}>
      {children}
    </BaseButton>
  )
}
