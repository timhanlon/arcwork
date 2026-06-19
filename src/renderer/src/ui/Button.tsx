import { Button as BaseButton } from "@base-ui/react/button"
import type { ComponentProps, JSX } from "react"

type Variant = "solid" | "ghost" | "quiet" | "danger" | "link"
type Size = "sm" | "md"

export interface ButtonProps extends Omit<ComponentProps<typeof BaseButton>, "className"> {
  readonly variant?: Variant
  readonly size?: Size
  readonly className?: string
}

// First component converted to Tailwind utilities under the v4 migration — also
// the end-to-end proof that the @theme token mapping resolves (text-foreground,
// border-accent, font-mono, etc. all bind to styles.css's :root vars).
const BASE =
  "font-mono border border-transparent rounded-[var(--radius)] bg-transparent text-foreground cursor-pointer outline-none focus-visible:outline-none disabled:opacity-40 disabled:cursor-default"

const SIZES: Record<Size, string> = {
  sm: "text-[10px] px-1.5 py-px",
  md: "text-[11px] px-[9px] py-[3px]",
}

// Inline text-link affordance: clickable text, no chrome. Bypasses BASE/SIZES so
// it inherits the surrounding font and size — callers override colour/font via
// className (defaults to the accent tone). The `size` prop is ignored for links.
const LINK =
  "cursor-pointer border-0 bg-transparent p-0 text-left text-accent outline-none hover:underline focus-visible:underline focus-visible:outline-none disabled:opacity-40 disabled:cursor-default"

const VARIANTS: Record<Exclude<Variant, "link">, string> = {
  solid:
    "border-border-strong enabled:hover:border-accent enabled:hover:text-accent focus-visible:border-accent focus-visible:text-accent",
  ghost:
    "text-fg-dim enabled:hover:border-border-strong enabled:hover:text-foreground focus-visible:border-border-strong focus-visible:text-foreground",
  quiet: "text-fg-dim px-0! enabled:hover:text-accent focus-visible:text-accent",
  danger:
    "border-[var(--request-border)] enabled:hover:border-[var(--request-strong)] enabled:hover:text-[var(--request-strong)] focus-visible:border-[var(--request-strong)] focus-visible:text-[var(--request-strong)]",
}

/**
 * The one button. Wraps base-ui's unstyled Button with arc's variants — replaces
 * the eight ad-hoc `.btn*` classes the old stylesheet grew. See
 * docs/proposals/2026-06-05-electron-ui-refactor.md.
 */
export function Button({ variant = "solid", size = "md", className, ...rest }: ButtonProps): JSX.Element {
  if (variant === "link") {
    return <BaseButton className={[LINK, className].filter(Boolean).join(" ")} {...rest} />
  }
  const cls = [BASE, SIZES[size], VARIANTS[variant], className].filter(Boolean).join(" ")
  return <BaseButton className={cls} {...rest} />
}
