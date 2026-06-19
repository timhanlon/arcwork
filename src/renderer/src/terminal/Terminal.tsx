import { type JSX, useEffect, useRef } from "react"
import { setActive, setSlot } from "./terminalRegistry.js"

/**
 * The terminal mount slot — a dumb point in the React tree the registry parents
 * the active pane's persistent xterm host into. It owns no xterm and no session
 * state: those live in {@link file://./terminalRegistry.ts} so they survive this
 * component unmounting (e.g. switching the right surface to git/work). On mount
 * it registers the slot element; whenever the active pane changes it tells the
 * registry, which reparents the right host in and parks the previous one.
 */
export function TerminalSurface({ activePaneId }: { activePaneId?: string }): JSX.Element {
  const slotRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    setSlot(slotRef.current)
    return () => setSlot(null)
  }, [])

  useEffect(() => {
    setActive(activePaneId ?? null)
  }, [activePaneId])

  return <div ref={slotRef} className="term-slot" />
}
