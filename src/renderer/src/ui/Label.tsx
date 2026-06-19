import type { ComponentPropsWithoutRef, JSX } from "react"

type Kind = "section" | "meta"

const BASE = "font-mono uppercase text-fg-faint"
const KINDS: Record<Kind, string> = {
  section: "text-[10px] tracking-[0.08em]",
  meta: "text-[10px] tracking-[0.06em]",
}

export interface LabelProps extends Omit<ComponentPropsWithoutRef<"span">, "className"> {
  readonly kind?: Kind
  readonly className?: string
}

/**
 * The micro-label recipe (mono · uppercase · tracked · faint) that the old
 * stylesheet copy-pasted across `.section-label`, `.chat-pane-meta`,
 * `.message-meta`, and friends. One component now owns it.
 */
export function Label({ kind = "meta", className, ...rest }: LabelProps): JSX.Element {
  const cls = [BASE, KINDS[kind], className].filter(Boolean).join(" ")
  return <span className={cls} {...rest} />
}
