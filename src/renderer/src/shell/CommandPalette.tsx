import { Dialog } from "@base-ui/react/dialog"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { type JSX, type KeyboardEvent, useMemo, useRef, useState } from "react"
import { KbdShortcut } from "../ui/Kbd.js"
import {
  type Command,
  type CommandChoice,
  filterByTitle,
  isParameterized,
  isPrompt,
} from "./commandPaletteModel.js"

export interface CommandPaletteProps {
  readonly commands: ReadonlyArray<Command>
  readonly onClose: () => void
}

// Stages: the command list; a picked command's second-stage targets (the
// workspace for "New chat in…", a repo's worktrees for "Open worktree…"); or a
// free-text entry (the branch name for "New worktree…"). Esc/Backspace in a
// second stage pops back to the command list rather than closing.
type Stage =
  | { readonly kind: "commands" }
  | { readonly kind: "choices"; readonly command: Command }
  | { readonly kind: "prompt"; readonly command: Command }

const ROW =
  "flex cursor-pointer items-center justify-between gap-3 px-3 py-1.5 text-[13px] outline-none data-[active=true]:bg-elev"

/** ⌘K command palette. A single overlay over the registry of app commands; some
 * commands open a second stage to pick a target (workspace today, worktree
 * next), which is how the comm/diff cross-product reaches the user without
 * nesting pickers in the composer. */
export function CommandPalette({ commands, onClose }: CommandPaletteProps): JSX.Element {
  const [query, setQuery] = useState("")
  const [stage, setStage] = useState<Stage>({ kind: "commands" })
  const [choiceItems, setChoiceItems] = useState<ReadonlyArray<CommandChoice>>([])
  const [loading, setLoading] = useState(false)
  const [active, setActive] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  // Drops a stale async-load result if the user has since backed out or entered
  // a different command's choices.
  const loadToken = useRef(0)

  const rows: ReadonlyArray<Command | CommandChoice> = useMemo(
    () =>
      stage.kind === "choices"
        ? filterByTitle(choiceItems, query)
        : stage.kind === "commands"
          ? filterByTitle(commands, query)
          : [],
    [stage, commands, choiceItems, query],
  )

  const toCommands = (): void => {
    loadToken.current += 1
    setStage({ kind: "commands" })
    setChoiceItems([])
    setLoading(false)
    setQuery("")
    setActive(0)
  }

  const enterChoices = (command: Command): void => {
    const token = (loadToken.current += 1)
    setStage({ kind: "choices", command })
    setQuery("")
    setActive(0)
    if (command.loadChoices) {
      setChoiceItems([])
      setLoading(true)
      command.loadChoices()
        .then((items) => {
          if (loadToken.current === token) {
            setChoiceItems(items)
            setLoading(false)
          }
        })
        .catch(() => {
          if (loadToken.current === token) {
            setChoiceItems([])
            setLoading(false)
          }
        })
    } else {
      setChoiceItems(command.choices ?? [])
    }
  }

  const pick = (index: number): void => {
    const row = rows[index]
    if (!row) return
    if (stage.kind === "choices") {
      stage.command.onChoose?.(row.id)
      onClose()
      return
    }
    const command = row as Command
    if (isParameterized(command)) {
      enterChoices(command)
      return
    }
    if (isPrompt(command)) {
      setStage({ kind: "prompt", command })
      setQuery("")
      setActive(0)
      return
    }
    command.run?.()
    onClose()
  }

  const submitPrompt = (): void => {
    if (stage.kind !== "prompt") return
    const value = query.trim()
    if (value === "") return
    stage.command.onSubmit?.(value)
    onClose()
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    switch (event.key) {
      case "ArrowDown":
        event.preventDefault()
        setActive((i) => (rows.length === 0 ? 0 : (i + 1) % rows.length))
        break
      case "ArrowUp":
        event.preventDefault()
        setActive((i) => (rows.length === 0 ? 0 : (i - 1 + rows.length) % rows.length))
        break
      case "Enter":
        event.preventDefault()
        if (stage.kind === "prompt") submitPrompt()
        else pick(active)
        break
      case "Escape":
        // Pop a second stage before letting the dialog close.
        if (stage.kind !== "commands") {
          event.preventDefault()
          event.stopPropagation()
          toCommands()
        }
        break
      case "Backspace":
        // Empty query in a second stage backs out to the command list.
        if (stage.kind !== "commands" && query === "") {
          event.preventDefault()
          toCommands()
        }
        break
      default:
        break
    }
  }

  const placeholder =
    stage.kind === "choices"
      ? (stage.command.choosePlaceholder ?? `${stage.command.title}…`)
      : stage.kind === "prompt"
        ? (stage.command.promptPlaceholder ?? `${stage.command.title}…`)
        : "type a command"

  return (
    <Dialog.Root
      open
      onOpenChange={(next) => {
        if (!next) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup
          initialFocus={inputRef}
          aria-label="Command palette"
          className="fixed left-1/2 top-[12vh] z-50 w-[min(560px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--radius)] border border-border-strong bg-background shadow-2xl outline-none"
        >
          <div className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <MagnifyingGlassIcon size={15} className="flex-none text-fg-faint" aria-hidden />
            <input
              ref={inputRef}
              value={query}
              placeholder={placeholder}
              onChange={(event) => {
                setQuery(event.target.value)
                setActive(0)
              }}
              onKeyDown={onKeyDown}
              className="w-full bg-transparent text-[13px] text-foreground outline-none placeholder:text-fg-faint"
            />
          </div>
          <ul className="max-h-[50vh] overflow-y-auto py-1">
            {stage.kind === "prompt" ? (
              <li className="px-3 py-2 text-[13px] text-fg-faint">
                {query.trim() === "" ? (
                  <span>{stage.command.promptPlaceholder ?? "type a value"}</span>
                ) : (
                  <span>
                    <span className="text-fg-dim">↵</span> {stage.command.title.replace(/…$/, "")}{" "}
                    <span className="font-mono text-foreground">{query.trim()}</span>
                  </span>
                )}
              </li>
            ) : loading ? (
              <li className="px-3 py-2 text-[13px] text-fg-faint">loading…</li>
            ) : rows.length === 0 ? (
              <li className="px-3 py-2 text-[13px] text-fg-faint">no matches</li>
            ) : (
              rows.map((row, index) => {
                const command = stage.kind === "commands" ? (row as Command) : undefined
                const choice = stage.kind === "choices" ? (row as CommandChoice) : undefined
                return (
                  <li
                    key={row.id}
                    data-active={index === active}
                    className={ROW}
                    onMouseMove={() => setActive(index)}
                    onClick={() => pick(index)}
                  >
                    <span className="min-w-0 truncate text-foreground">{row.title}</span>
                    {choice?.subtitle ? (
                      <span className="ml-auto truncate font-mono text-[11px] text-fg-faint">
                        {choice.subtitle}
                      </span>
                    ) : null}
                    {command?.combo ? <KbdShortcut combo={command.combo} /> : null}
                    {command && isParameterized(command) ? (
                      <span className="text-fg-faint">›</span>
                    ) : null}
                  </li>
                )
              })
            )}
          </ul>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
