import { Select as BaseSelect } from "@base-ui/react/select"
import { CaretUpDown, Check } from "@phosphor-icons/react"
import type { JSX, ReactNode } from "react"

/**
 * A themed single-value picker built on Base UI's `select`. We use this instead
 * of a native `<select>` because Electron renders the native popup with OS
 * chrome that ignores our dark theme; this one portals a styled popup that
 * matches {@link ../components/TranscriptFilterMenu.TranscriptFilterMenu} and
 * the rest of the app. The active row carries a checkmark; the trigger reads out
 * the current label so state is legible without opening it.
 */

export interface SelectOption<T extends string> {
  readonly value: T
  /** Display text; falls back to the raw value. */
  readonly label?: ReactNode
}

export interface SelectProps<T extends string> {
  /** The current value, or null when nothing is chosen yet. */
  readonly value: T | null
  readonly options: ReadonlyArray<SelectOption<T>>
  readonly onValueChange: (value: T) => void
  readonly disabled?: boolean
  /** Shown in the trigger while {@link value} is null. */
  readonly placeholder?: string
  /** Extra trigger classes, appended to the themed base (e.g. layout tweaks). */
  readonly className?: string
  readonly "aria-label"?: string
}

// No width here: an `inline-flex` trigger sizes to its content by default (what
// the work header wants). Form callers pass `w-full` via `className` to stretch.
// Width is set at the call site rather than baked in because Tailwind can't
// reliably override a baked `w-full` from the class string — source order, not
// attribute order, decides the winner.
const TRIGGER =
  "inline-flex items-center justify-between gap-2 rounded-[var(--radius)] border border-border bg-input px-2 py-1.5 font-sans text-[13px] text-foreground outline-none cursor-pointer hover:border-border-strong focus-visible:border-accent disabled:cursor-not-allowed disabled:opacity-50 data-[popup-open]:border-accent"
const POPUP =
  "min-w-[var(--anchor-width)] origin-[var(--transform-origin)] rounded-[var(--radius)] border border-border-strong bg-elev p-1 font-sans text-[13px] shadow-lg outline-none"
const ITEM =
  "flex cursor-pointer select-none items-center gap-2 rounded-[var(--radius)] px-2 py-1 pr-3 text-fg-dim outline-none data-[highlighted]:bg-input data-[highlighted]:text-foreground data-[selected]:text-foreground"

export function Select<T extends string>(props: SelectProps<T>): JSX.Element {
  const { value, options, onValueChange, disabled, placeholder, className } = props
  const items = Object.fromEntries(
    options.map((o) => [o.value, o.label ?? o.value]),
  ) as Record<string, ReactNode>

  return (
    <BaseSelect.Root
      items={items}
      value={value}
      disabled={disabled}
      onValueChange={(next) => {
        if (next != null) onValueChange(next as T)
      }}
    >
      <BaseSelect.Trigger
        className={className ? `${TRIGGER} ${className}` : TRIGGER}
        aria-label={props["aria-label"]}
      >
        <BaseSelect.Value>{(v) => (v == null ? (placeholder ?? "—") : items[v])}</BaseSelect.Value>
        <BaseSelect.Icon className="flex-none text-fg-faint">
          <CaretUpDown size={13} />
        </BaseSelect.Icon>
      </BaseSelect.Trigger>
      <BaseSelect.Portal>
        <BaseSelect.Positioner
          className="z-50"
          side="bottom"
          align="start"
          sideOffset={4}
          alignItemWithTrigger={false}
        >
          <BaseSelect.Popup className={POPUP}>
            {options.map((option) => (
              <BaseSelect.Item key={option.value} value={option.value} className={ITEM}>
                {/* Fixed-width slot keeps labels aligned whether or not the row is
                    the checked one — the indicator only mounts when selected. */}
                <span className="flex w-3 flex-none justify-center">
                  <BaseSelect.ItemIndicator>
                    <Check size={11} weight="bold" />
                  </BaseSelect.ItemIndicator>
                </span>
                <BaseSelect.ItemText>{option.label ?? option.value}</BaseSelect.ItemText>
              </BaseSelect.Item>
            ))}
          </BaseSelect.Popup>
        </BaseSelect.Positioner>
      </BaseSelect.Portal>
    </BaseSelect.Root>
  )
}
