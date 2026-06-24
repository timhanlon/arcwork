import { Autocomplete } from "@base-ui/react/autocomplete"
import type { ChatId, WorkId, WorkspaceId } from "../../../shared/ids.js"
import { Dialog } from "@base-ui/react/dialog"
import { Toggle } from "@base-ui/react/toggle"
import { ToggleGroup } from "@base-ui/react/toggle-group"
import { MagnifyingGlassIcon } from "@phosphor-icons/react"
import { type JSX, type KeyboardEvent, useEffect, useMemo, useRef, useState } from "react"
import type { Chat } from "../../../shared/chat.js"
import type { ArcSearchHit, ArcSearchKind } from "../../../shared/read.js"
import { Button } from "../ui/Button.js"
import { formatActivityDateTime, formatRelativeTime } from "../chat/activity-event-display.js"
import { rpc } from "../rpc-client.js"
import { useShellActions } from "../shell/ShellActionsContext.js"
import {
  buildArcSearchParams,
  labelForSearchHit,
  subtitleForSearchHit,
  targetFromSearchHit,
  workspaceIdForSearchTarget,
} from "./arcSearchModel.js"

export interface ArcSearchPanelProps {
  readonly chats: ReadonlyArray<Chat>
  readonly currentChatId?: ChatId
  readonly onOpenChat: (workspaceId: WorkspaceId, chatId: ChatId) => void
  readonly onClose: () => void
}

const KINDS: ReadonlyArray<ArcSearchKind> = ["work", "chat", "message"]

const kindLabel = (kind: ArcSearchKind): string => (kind === "message" ? "msgs" : kind)

/** A filter chip — quiet by default, accented when pressed; used by the kind
 * group's toggles. */
const CHIP =
  "cursor-pointer rounded-[var(--radius)] border border-transparent px-1.5 py-0.5 font-mono text-[10px] lowercase text-fg-dim outline-none enabled:hover:text-foreground focus-visible:border-border-strong disabled:cursor-default disabled:opacity-40 data-[pressed]:text-accent"

export function ArcSearchPanel({
  chats,
  currentChatId,
  onOpenChat,
  onClose,
}: ArcSearchPanelProps): JSX.Element {
  const { open } = useShellActions()
  const onOpenWork = (workId: WorkId): void => open({ kind: "work", workId }, "right")
  const [query, setQuery] = useState("")
  const [kinds, setKinds] = useState<ReadonlySet<ArcSearchKind>>(() => new Set(["work"]))
  const [hits, setHits] = useState<ReadonlyArray<ArcSearchHit>>([])
  const [total, setTotal] = useState(0)
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [openingRef, setOpeningRef] = useState<string | undefined>()
  const [error, setError] = useState<string | undefined>()
  const requestId = useRef(0)
  const inputRef = useRef<HTMLInputElement>(null)

  // Every search anchors to the current chat's workspace — the backend has no
  // unanchored, profile-global search (read-service.test.ts:154). Without an
  // open chat there is nothing to anchor to, so the palette can't search.
  const currentWorkspaceId = useMemo(
    () => chats.find((chat) => chat.id === currentChatId)?.workspaceId,
    [chats, currentChatId],
  )
  const canSearchMessages = currentChatId !== undefined
  // Message search only makes sense scoped to a chat — drop it everywhere else so
  // the request and the filter chips agree.
  const effectiveKinds = useMemo(() => {
    if (canSearchMessages) return kinds
    return new Set(Array.from(kinds).filter((kind) => kind !== "message"))
  }, [canSearchMessages, kinds])
  const draft = useMemo(
    () => ({ query, kinds: effectiveKinds, scope: "currentChat" as const, currentWorkspaceId, currentChatId }),
    [query, effectiveKinds, currentWorkspaceId, currentChatId],
  )

  useEffect(() => {
    const id = ++requestId.current
    setLoading(true)
    setError(undefined)
    const timeout = window.setTimeout(() => {
      rpc("SearchArc", { params: buildArcSearchParams(draft) })
        .then((result) => {
          if (id !== requestId.current) return
          setHits(result.hits)
          setTotal(result.total)
          setNextCursor(result.nextCursor)
        })
        .catch((err: unknown) => {
          if (id !== requestId.current) return
          setHits([])
          setTotal(0)
          setNextCursor(null)
          setError(err instanceof Error ? err.message : "Search failed")
        })
        .finally(() => {
          if (id === requestId.current) setLoading(false)
        })
    }, draft.query.trim().length > 0 ? 160 : 0)
    return () => window.clearTimeout(timeout)
  }, [draft])

  const setKindsFromToggle = (next: ReadonlyArray<string>): void => {
    const allowed = next.filter((kind): kind is ArcSearchKind =>
      KINDS.includes(kind as ArcSearchKind) && (kind !== "message" || canSearchMessages),
    )
    // Never let the group empty out — an empty `kinds` would search nothing.
    setKinds(allowed.length > 0 ? new Set(allowed) : new Set(["work"]))
  }

  const loadMore = (): void => {
    if (!nextCursor || loadingMore) return
    setLoadingMore(true)
    setError(undefined)
    rpc("SearchArc", { params: buildArcSearchParams(draft, nextCursor) })
      .then((result) => {
        setHits((current) => [...current, ...result.hits])
        setTotal(result.total)
        setNextCursor(result.nextCursor)
      })
      .catch((err: unknown) => setError(err instanceof Error ? err.message : "Search failed"))
      .finally(() => setLoadingMore(false))
  }

  const openHit = async (hit: ArcSearchHit): Promise<void> => {
    setOpeningRef(hit.ref)
    setError(undefined)
    try {
      const result = await rpc("GetArc", { params: { ref: hit.ref } })
      const target = targetFromSearchHit(hit, result.entities)
      if (!target) return
      if (target.kind === "work") {
        onOpenWork(target.workId)
        onClose()
        return
      }
      const workspaceId = workspaceIdForSearchTarget(chats, target)
      if (workspaceId) {
        onOpenChat(workspaceId, target.chatId)
        onClose()
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not open result")
    } finally {
      setOpeningRef(undefined)
    }
  }

  const status =
    error ??
    (currentChatId === undefined
      ? "open a chat to search"
      : loading
        ? "searching…"
        : "no results")

  return (
    <Dialog.Root
      open
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onClose()
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="fixed inset-0 z-40 bg-black/40" />
        <Dialog.Popup
          initialFocus={inputRef}
          aria-label="Search Arc"
          className="fixed left-1/2 top-[12vh] z-50 w-[min(640px,92vw)] -translate-x-1/2 overflow-hidden rounded-[var(--radius)] border border-border-strong bg-background shadow-2xl outline-none"
        >
          {/* `open` is pinned so the list stays visible inside the dialog; the
              Dialog owns dismissal (Esc/backdrop). Server-side filtering, so
              `mode="none"` shows `items` verbatim. */}
          <Autocomplete.Root
            items={hits}
            mode="none"
            open
            onOpenChange={() => {}}
            value={query}
            onValueChange={(value) => setQuery(value)}
            autoHighlight="always"
          >
            <div className="flex items-center gap-2 px-3 py-2.5">
              <MagnifyingGlassIcon size={15} className="flex-none text-fg-faint" aria-hidden />
              <Autocomplete.Input
                render={
                  <input
                    ref={inputRef}
                    placeholder="search work, chats, messages"
                    className="min-w-0 flex-1 bg-transparent font-mono text-[13px] text-foreground outline-none placeholder:text-fg-faint"
                    onKeyDown={(event: KeyboardEvent<HTMLInputElement>) => {
                      if (event.key === "Escape") onClose()
                    }}
                  />
                }
              />
              <ToggleGroup
                value={Array.from(effectiveKinds)}
                onValueChange={setKindsFromToggle}
                aria-label="Result kinds"
                className="flex flex-none items-center gap-0.5"
              >
                {KINDS.map((kind) => (
                  <Toggle
                    key={kind}
                    value={kind}
                    disabled={kind === "message" && !canSearchMessages}
                    title={kind === "message" && !canSearchMessages ? "Message search needs an open chat" : `Search ${kind}`}
                    className={CHIP}
                  >
                    {kindLabel(kind)}
                  </Toggle>
                ))}
              </ToggleGroup>
            </div>

            <div className="max-h-[52vh] overflow-y-auto border-t border-border">
              <Autocomplete.List className="p-1">
                {(hit: ArcSearchHit) => (
                  <Autocomplete.Item
                    key={hit.ref}
                    value={hit}
                    onClick={() => void openHit(hit)}
                    className="flex cursor-default flex-col gap-0.5 rounded-[var(--radius)] px-2.5 py-1.5 outline-none data-[highlighted]:bg-elev"
                  >
                    <span className="flex min-w-0 items-center gap-2">
                      <span className="flex-none font-mono text-[9px] uppercase tracking-[0.06em] text-fg-faint">
                        {labelForSearchHit(hit)}
                      </span>
                      <span className="min-w-0 flex-1 truncate text-[12px] text-foreground">{hit.title}</span>
                      {hit.message ? (
                        <span className="flex-none font-mono text-[10px] text-fg-faint">{subtitleForSearchHit(hit)}</span>
                      ) : hit.kind === "chat" ? (
                        <time
                          className="flex-none font-mono text-[10px] text-fg-faint"
                          dateTime={hit.updatedAt}
                          title={formatActivityDateTime(hit.updatedAt)}
                        >
                          {formatRelativeTime(hit.updatedAt)}
                        </time>
                      ) : null}
                    </span>
                    {hit.preview ? (
                      <span className="line-clamp-1 text-[11px] leading-snug text-fg-dim">
                        {openingRef === hit.ref ? "opening…" : hit.preview}
                      </span>
                    ) : null}
                  </Autocomplete.Item>
                )}
              </Autocomplete.List>
              {hits.length === 0 ? (
                <div className="px-3 py-6 text-center font-mono text-[11px] text-fg-faint">{status}</div>
              ) : null}
            </div>

            {nextCursor ? (
              <div className="border-t border-border p-1">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={loadingMore}
                  onClick={loadMore}
                  className="w-full text-center"
                >
                  {loadingMore ? "loading…" : `more (${hits.length}/${total})`}
                </Button>
              </div>
            ) : null}
          </Autocomplete.Root>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  )
}
