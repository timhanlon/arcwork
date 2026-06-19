import { type JSX, type KeyboardEvent, type ReactNode, useEffect, useRef, useState } from "react"
import { Button } from "@base-ui/react/button"
import type { Chat } from "../../../shared/chat.js"
import { CHAT_LABEL, ROW_ACTIVE, ROW_BASE, ROW_GRID, TREE_MAIN } from "./row-styles.js"

export interface ChatRowProps {
  readonly chat: Chat
  readonly selected: boolean
  /** total sessions under this chat — rendered as a trailing count when > 0 */
  readonly sessionCount: number
  /** how many of those sessions still await the user — rendered as a badge when > 0 */
  readonly pendingCount: number
  readonly onSelect: () => void
  readonly onRename?: (title: string) => Promise<void>
  /**
   * The 18px disclosure-column slot. The tree fills it with the live
   * `Collapsible.Trigger`; stories pass a static chevron so the row reads
   * complete in isolation.
   */
  readonly disclosure: ReactNode
}

/**
 * A chat row: disclosure gutter + title, a request-toned pending badge, and a
 * faint session count. Badges only appear when their count is non-zero.
 */
export function ChatRow({ chat, selected, sessionCount, pendingCount, onSelect, onRename, disclosure }: ChatRowProps): JSX.Element {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState(chat.title)
  const [error, setError] = useState<string | undefined>(undefined)
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    if (!editing) setDraft(chat.title)
  }, [chat.title, editing])

  useEffect(() => {
    if (editing) inputRef.current?.focus()
  }, [editing])

  const beginEdit = (): void => {
    if (!onRename) return
    setDraft(chat.title)
    setError(undefined)
    setEditing(true)
  }

  const cancelEdit = (): void => {
    setDraft(chat.title)
    setError(undefined)
    setEditing(false)
  }

  const commitEdit = async (): Promise<void> => {
    if (!onRename || saving) return
    const title = draft.trim()
    if (title.length === 0) {
      setError("Title cannot be empty")
      return
    }
    if (title === chat.title) {
      setEditing(false)
      setError(undefined)
      return
    }
    setSaving(true)
    setError(undefined)
    try {
      await onRename(title)
      setEditing(false)
    } catch (e: unknown) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    if (event.key === "Enter") {
      event.preventDefault()
      void commitEdit()
    } else if (event.key === "Escape") {
      event.preventDefault()
      cancelEdit()
    }
  }

  return (
    <div className={ROW_GRID} role="treeitem" aria-expanded="true" data-editing={editing || undefined}>
      {disclosure}
      {editing ? (
        <div className={`${ROW_BASE} min-w-0 flex-col items-stretch gap-1 ${selected ? ROW_ACTIVE : ""}`}>
          <input
            ref={inputRef}
            className="min-w-0 border border-border-strong bg-background px-1 py-0.5 font-sans text-[12px] text-foreground outline-none focus:border-accent"
            value={draft}
            disabled={saving}
            aria-label="Chat title"
            onChange={(event) => setDraft(event.currentTarget.value)}
            onKeyDown={onKeyDown}
            onBlur={() => void commitEdit()}
          />
          {error && <span className="font-mono text-[10px] text-request">{error}</span>}
        </div>
      ) : (
        <div className="flex min-w-0">
          <Button
            className={`${ROW_BASE} min-w-0 flex-1 justify-between gap-2 ${selected ? ROW_ACTIVE : ""}`}
            title={chat.id}
            onClick={onSelect}
            onDoubleClick={(event) => {
              if (!onRename) return
              event.preventDefault()
              beginEdit()
            }}
          >
            <span className={TREE_MAIN}>
              <span className={CHAT_LABEL}>{chat.title}</span>
            </span>
          </Button>
        </div>
      )}
    </div>
  )
}
