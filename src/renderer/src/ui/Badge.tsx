import type { ComponentPropsWithoutRef, JSX } from "react"

type Tone = "neutral" | "danger" | "request"

const BASE = "font-mono text-[9px] uppercase tracking-[0.06em]"
const TONES: Record<Tone, string> = {
  neutral: "text-fg-dim",
  danger: "text-danger",
  request: "text-[var(--request-strong)]",
}

export interface BadgeProps extends Omit<ComponentPropsWithoutRef<"span">, "className"> {
  readonly tone?: Tone
  readonly className?: string
}

/** Small mono chip for counts and states (tree counts, session state, request state). */
export function Badge({ tone = "neutral", className, ...rest }: BadgeProps): JSX.Element {
  const cls = [BASE, TONES[tone], className].filter(Boolean).join(" ")
  return <span className={cls} {...rest} />
}
