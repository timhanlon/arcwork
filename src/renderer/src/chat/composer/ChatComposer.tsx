import {
  forwardRef,
  type JSX,
  useCallback,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react"
import { Combobox } from "@base-ui/react/combobox"
import type { BaseUIEvent } from "@base-ui/react/types"
import { comboFor, matchesCombo, REFERENCE_TRIGGER } from "../../shell/keybindings.js"
import { caretRect } from "./caret.js"
import {
  type ActiveMention,
  type ReferenceCandidate,
  type ReferenceKind,
  applyReference,
  detectMention,
  filterCandidates,
  removeMention,
} from "./references.js"

// Resolved once at module load — the combo that sends the draft.
const SEND_COMBO = comboFor("sendMessage")

export interface ChatComposerProps {
  readonly value: string
  readonly onChange: (next: string) => void
  /** Send the current draft (Shift+Enter, only when the reference picker is closed). */
  readonly onSend: () => void
  readonly disabled?: boolean
  readonly placeholder?: string
  /** Every referenceable target (work, files, sessions); filtered per `@`-query. */
  readonly candidates: ReadonlyArray<ReferenceCandidate>
  /**
   * Selecting a session is a routing command, not a text insert: it retargets
   * the composer to that session id (the "to <target>" footer) and leaves the
   * draft body clean. Called with the chosen session's id.
   */
  readonly onSelectTarget?: (sessionId: string) => void
  /** Called when an `@`-mention becomes active — the cue to lazily load files. */
  readonly onMention?: () => void
  /** True when the workspace file list was capped, surfaced as a popup footer. */
  readonly filesTruncated?: boolean
}

/** Imperative handle: the shell drops focus here on a ⌘L "focus the composer" intent. */
export interface ComposerHandle {
  readonly focus: () => void
}

/** ~3 lines at 12px / 1.45 + vertical padding. */
const COMPOSER_MIN_HEIGHT = 72
/** ~10 lines before the draft scrolls inside the box. */
const COMPOSER_MAX_HEIGHT = 200

const TEXTAREA_CLASS =
  "m-0 min-h-[72px] w-full resize-none overflow-y-hidden rounded-[var(--radius)] border border-border bg-input px-3 py-2.5 font-mono text-[12px] leading-[1.45] text-foreground focus:border-accent focus:outline-none disabled:opacity-60"

const syncTextareaHeight = (ta: HTMLTextAreaElement): void => {
  ta.style.height = "auto"
  const scrollHeight = ta.scrollHeight
  ta.style.height = `${Math.min(Math.max(scrollHeight, COMPOSER_MIN_HEIGHT), COMPOSER_MAX_HEIGHT)}px`
  ta.style.overflowY = scrollHeight > COMPOSER_MAX_HEIGHT ? "auto" : "hidden"
}

const KIND_LABEL: Record<ReferenceKind, string> = { work: "work", file: "file", session: "sess" }

/**
 * The chat composer textarea with an inline `@` reference picker. Typing the
 * trigger (see {@link REFERENCE_TRIGGER}) at a word boundary opens a Base UI
 * Autocomplete popup, anchored at the caret, over a unified list of targets —
 * work, files, and sessions in one place rather than a sigil per kind. Base UI
 * owns the popup's keyboard navigation and ARIA (focus stays in the textarea via
 * its virtual-focus model); this component owns the `@`-token detection, the
 * caret anchor, and splicing the chosen reference into the draft.
 */
export const ChatComposer = forwardRef<ComposerHandle, ChatComposerProps>(function ChatComposer(
  props,
  ref,
): JSX.Element {
  const { value, onChange, onSend, disabled, placeholder, candidates, onSelectTarget, onMention, filesTruncated } =
    props
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [mention, setMention] = useState<ActiveMention | null>(null)

  // ⌘L focus intent (driven by the shell through this handle): drop the cursor
  // into the textarea with the caret at the draft's end, so the user types
  // straight onto their in-progress message.
  useImperativeHandle(ref, () => ({
    focus: () => {
      const ta = textareaRef.current
      if (!ta) return
      ta.focus()
      const end = ta.value.length
      ta.setSelectionRange(end, end)
    },
  }), [])

  useLayoutEffect(() => {
    const ta = textareaRef.current
    if (ta) syncTextareaHeight(ta)
  }, [value])

  const filtered = useMemo(
    () => (mention ? filterCandidates(candidates, mention.query) : []),
    [candidates, mention],
  )
  const open = mention !== null && filtered.length > 0

  const syncMention = useCallback(
    (text: string, caret: number): void => {
      const next = detectMention(text, caret, REFERENCE_TRIGGER)
      setMention(next)
      if (next) onMention?.()
    },
    [onMention],
  )

  const selectCandidate = useCallback(
    (candidate: ReferenceCandidate): void => {
      if (!mention) return
      // A session is a routing command: retarget the composer and drop the
      // `@query` from the body. Work and files splice a text token in place.
      const { value: next, caret } =
        candidate.kind === "session"
          ? removeMention(value, mention, REFERENCE_TRIGGER)
          : applyReference(value, mention, candidate, REFERENCE_TRIGGER)
      if (candidate.kind === "session") onSelectTarget?.(candidate.insertText)
      // We own the draft: splice it directly. Base UI's own input-value pushes
      // (the fill it does on select) never reach the draft — it's driven only by
      // the textarea's onChange — so there's nothing here to guard against.
      onChange(next)
      setMention(null)
      requestAnimationFrame(() => {
        const ta = textareaRef.current
        if (ta) {
          ta.focus()
          ta.setSelectionRange(caret, caret)
        }
      })
    },
    [mention, onChange, onSelectTarget, value],
  )

  // A virtual floating-ui anchor that re-reads the caret rect on each position
  // pass, so the popup tracks the `@` as the draft grows.
  const anchor = useMemo(
    () => ({
      getBoundingClientRect: (): DOMRect => {
        const ta = textareaRef.current
        if (!ta || !mention) return new DOMRect(0, 0, 0, 0)
        return caretRect(ta, mention.start)
      },
    }),
    [mention],
  )

  // The draft is driven here, by the textarea's own input — never by Base UI's
  // onInputValueChange. That's deliberate: Base UI pushes input values we don't
  // want (the fill on select, the revert-to-selected on Escape/close, which with
  // no selection is an empty string); routing the draft through the real input
  // event means those programmatic pushes can't touch it.
  const handleInput = useCallback(
    (event: React.ChangeEvent<HTMLTextAreaElement>): void => {
      const ta = event.currentTarget
      onChange(ta.value)
      syncMention(ta.value, ta.selectionStart ?? ta.value.length)
    },
    [onChange, syncMention],
  )

  const handleCaretSync = useCallback(
    (event: React.SyntheticEvent<HTMLTextAreaElement>): void => {
      const ta = event.currentTarget
      syncMention(ta.value, ta.selectionStart ?? ta.value.length)
    },
    [syncMention],
  )

  const handleKeyDown = useCallback(
    (event: BaseUIEvent<React.KeyboardEvent<HTMLTextAreaElement>>): void => {
      // With the picker closed, ArrowUp/ArrowDown belong to the textarea for
      // line-by-line cursor movement. Base UI's combobox input otherwise routes
      // bare arrows into list navigation (opening/highlighting the popup, calling
      // preventDefault), which strands the caret. Base UI runs our keydown first
      // and skips its own when we flag the event, so we opt out here; when the
      // popup is open the arrows fall through to navigate it.
      if (!open && (event.key === "ArrowUp" || event.key === "ArrowDown")) {
        event.preventBaseUIHandler()
        return
      }
      // Escape closes the picker in one press and leaves the draft untouched.
      // We own `open` (via mention), so close it ourselves and stop the event —
      // Base UI's own Escape handling only deactivates the highlight on the first
      // press, and would otherwise try to revert the input.
      if (event.key === "Escape" && mention) {
        event.preventDefault()
        event.stopPropagation()
        setMention(null)
        return
      }
      // With the picker closed, Escape releases the composer back to the shell —
      // the inverse of ⌘L — so the reader can scroll the transcript or fire a
      // shell shortcut without the textarea swallowing it.
      if (event.key === "Escape") {
        event.currentTarget.blur()
        return
      }
      // The `sendMessage` combo (Shift+Enter by default) sends — but never while
      // picking a reference, where Enter belongs to the popup (plain Enter selects
      // the highlighted item). Matched against the registry so a rebind is honoured
      // here and in the composer-footer hint at once.
      if (matchesCombo(event.nativeEvent, SEND_COMBO)) {
        event.preventDefault()
        if (!mention) onSend()
      }
    },
    [mention, onSend, open],
  )

  return (
    <Combobox.Root
      items={filtered}
      // We pre-filter `candidates` by the active `@`-query ourselves; the input
      // holds the whole draft, not the query, so Base UI's own matcher would hide
      // everything. `filter={null}` shows `items` verbatim.
      filter={null}
      value={null}
      onValueChange={(candidate) => {
        if (candidate) selectCandidate(candidate)
      }}
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) setMention(null)
      }}
      inputValue={value}
      // Required for Base UI's controlled input, but intentionally inert: the
      // draft is owned by the textarea's onChange (see handleInput), so we don't
      // let Base UI's value pushes write through here.
      onInputValueChange={() => {}}
      autoHighlight
      itemToStringLabel={(candidate: ReferenceCandidate) => candidate.label}
    >
      <Combobox.Input
        render={
          <textarea
            ref={textareaRef}
            rows={1}
            placeholder={placeholder}
            disabled={disabled}
            className={TEXTAREA_CLASS}
            onChange={handleInput}
            onKeyDown={handleKeyDown}
            onKeyUp={handleCaretSync}
            onClick={handleCaretSync}
          />
        }
      />
      <Combobox.Portal>
        <Combobox.Positioner anchor={anchor} side="top" align="start" sideOffset={6} className="z-50">
          <Combobox.Popup className="max-h-[280px] w-[min(420px,90vw)] overflow-y-auto rounded-[var(--radius)] border border-border-strong bg-elev py-1 shadow-lg">
            <Combobox.Empty className="px-3 py-2 font-mono text-[11px] text-fg-faint">
              no matching targets
            </Combobox.Empty>
            <Combobox.List>
              {(candidate: ReferenceCandidate) => (
                <Combobox.Item
                  key={candidate.key}
                  value={candidate}
                  className="flex cursor-default items-baseline gap-2 px-3 py-1.5 text-[12px] data-[highlighted]:bg-accent/15"
                >
                  <span className="w-9 flex-none font-mono text-[10px] uppercase tracking-[0.06em] text-fg-faint">
                    {KIND_LABEL[candidate.kind]}
                  </span>
                  <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-foreground">
                    {candidate.label}
                  </span>
                  {candidate.detail && (
                    <span className="flex-none overflow-hidden text-ellipsis whitespace-nowrap font-mono text-[10px] text-fg-dim">
                      {candidate.detail}
                    </span>
                  )}
                </Combobox.Item>
              )}
            </Combobox.List>
            {filesTruncated && (
              <div className="border-t border-border px-3 py-1.5 font-mono text-[10px] text-fg-faint">
                file list truncated — refine your query
              </div>
            )}
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  )
})
