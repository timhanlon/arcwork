import { Chat, File, Notebook, X } from "@phosphor-icons/react"
import type { JSX } from "react"
import type { CenterTab } from "./arcShellMachine.js"

export function CenterTabStrip({
  tabs,
  activeId,
  onSelect,
  onClose,
}: {
  readonly tabs: ReadonlyArray<CenterTab>
  readonly activeId: string
  readonly onSelect: (tab: CenterTab) => void
  readonly onClose: (id: string) => void
}): JSX.Element {
  return (
    <div className="flex h-full min-w-0 items-stretch" role="tablist" aria-label="Open center tabs">
      {tabs.map((tab) => {
        const active = tab.id === activeId
        const label = tab.kind === "file" ? tab.path.split("/").at(-1) ?? tab.path : tab.kind === "work" ? "Work" : "Chat"
        const Icon = tab.kind === "file" ? File : tab.kind === "work" ? Notebook : Chat
        return (
          <div
            key={tab.id}
            className={`group flex min-w-0 items-center border-x border-border ${active ? "bg-elev text-foreground" : "text-fg-dim hover:bg-elev/60"}`}
          >
            <button
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => onSelect(tab)}
              title={tab.kind === "file" ? tab.path : label}
              className="flex min-w-0 items-center gap-1.5 px-2 text-[12px] focus-visible:bg-elev focus-visible:outline-none"
            >
              <Icon size={14} weight="regular" aria-hidden />
              <span className="max-w-40 truncate">{label}</span>
            </button>
            {tab.kind !== "chat" ? (
              <button
                type="button"
                aria-label={`Close ${label}`}
                title={`Close ${label}`}
                onClick={() => onClose(tab.id)}
                className="mr-1 rounded p-0.5 text-fg-faint hover:bg-elev hover:text-foreground focus-visible:bg-elev focus-visible:outline-none"
              >
                <X size={12} weight="bold" />
              </button>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}
