import { Button as BaseButton } from "@base-ui/react/button"
import type { ComponentProps, JSX, ReactNode } from "react"

export interface ChipProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  readonly children: ReactNode
  /** Selected/pressed treatment — accent border, plus aria-pressed for the toggle semantics. */
  readonly active?: boolean
  readonly className?: string
}

// The shared chip skeleton: a small bordered pill button. `focus-visible:ring-1`
// sets the ring width but not its colour — callers pick ring-accent vs ring-request
// — so two ring-colour utilities never collide on one element (this Tailwind setup
// has no class-merge; conflicts would otherwise need `!`). The companion to
// {@link Button}/{@link IconButton} for filter tabs and status chips.
const BASE =
  "inline-flex items-center gap-1.5 cursor-pointer rounded-[var(--radius)] border px-2 py-0.5 font-mono text-[11px] outline-none focus-visible:outline-none focus-visible:ring-1 disabled:opacity-40 disabled:cursor-default"

// Resting chip: quiet border + dimmed label. The active *fill*/label tone differs
// per use (filter tabs go accent text, status chips fill), so `active` owns only
// the universally-shared accent border — callers supply the rest via className.
const REST = "border-border text-fg-dim"
const ACTIVE = "border-accent"

export function Chip({ children, active = false, className, ...rest }: ChipProps): JSX.Element {
  const cls = [BASE, active ? ACTIVE : REST, className].filter(Boolean).join(" ")
  return (
    <BaseButton className={cls} aria-pressed={active} {...rest}>
      {children}
    </BaseButton>
  )
}
