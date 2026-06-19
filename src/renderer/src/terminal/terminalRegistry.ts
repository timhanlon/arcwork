import { Terminal } from "@xterm/xterm"
import { FitAddon } from "@xterm/addon-fit"
import "@xterm/xterm/css/xterm.css"
import type { ArcShellActor } from "../shell/arcShellMachine.js"
import { subscribeWhenReady } from "../bridge.js"
import { traceResize, traceWrite } from "./pty-trace.js"
import { createPreBindBuffer, type PreBindBuffer } from "./ptyReplayBuffer.js"

/**
 * Terminal registry — decouples xterm lifetime from React render lifetime.
 *
 * The bug this fixes: the right surface conditionally renders terminal vs git vs
 * work, so switching to git *unmounts* the terminal surface and React's effect
 * cleanup used to `term.dispose()` every xterm. Switching back minted a fresh
 * xterm → bare cursor, the live screen lost. Any conditional render above a
 * terminal could kill it because lifetime was tied to render.
 *
 * Here each pane's xterm + its persistent DOM host are owned by a module
 * singleton keyed by `paneId`, created lazily and disposed only when the pane is
 * truly closed (reconciled against the machine's `panes` list — see {@link sync}).
 * React supplies a single mount *slot*; the registry re-parents the active pane's
 * host into it and **parks** the rest offscreen. The xterm keeps receiving its
 * session's bytes while parked (the data subscription lives here, not in React),
 * so switch-back reattaches a fully-populated screen instead of a new emulator.
 *
 * This subsumes the old opacity-stack keep-alive: liveness now comes from the
 * persistent host, not from N always-mounted panes.
 */

export interface TerminalPaneSpec {
  readonly id: string
  readonly sessionId?: string
  /** `resumeSessionId !== undefined` — measure on first show even with a session. */
  readonly measureOnMount: boolean
}

export interface TerminalRegistryDeps {
  readonly shellActor: ArcShellActor
  readonly onMeasured: (paneId: string, cols: number, rows: number) => void
}

interface Entry {
  readonly id: string
  readonly term: Terminal
  readonly fit: FitAddon
  /** The element xterm was `open()`ed on; reparented between slot and parking lot. */
  readonly host: HTMLDivElement
  readonly replay: PreBindBuffer
  sessionId: string | undefined
  /** True until the first attach measures + reports the spawn size. */
  pendingMeasure: boolean
  /** True while this entry's host is in the live slot (visible/focused). */
  active: boolean
  savedViewportY: number
  /** True if the viewport was pinned to the bottom (following live output) at save. */
  savedAtBottom: boolean
  dispose(): void
}

// Offscreen container that holds parked hosts. Kept at a real, non-zero size so a
// parked xterm/addon never fits to zero dimensions; we simply never resize the
// PTY while parked (see `attachActive`/the ResizeObserver gate below).
let parkingLot: HTMLDivElement | undefined
const getParkingLot = (): HTMLDivElement => {
  if (parkingLot) return parkingLot
  const el = document.createElement("div")
  el.className = "term-parking-lot"
  el.style.cssText =
    "position:fixed;left:-100000px;top:0;width:1000px;height:800px;overflow:hidden;pointer-events:none"
  document.body.appendChild(el)
  parkingLot = el
  return el
}

const entries = new Map<string, Entry>()
let deps: TerminalRegistryDeps | undefined
let slot: HTMLElement | null = null
let activeId: string | null = null
// Which pane's host currently lives in the slot. Drives idempotent reconciliation
// in render(): the registry can be poked from either the App-level sync effect or
// the slot component in any order without double-attaching or losing a host.
let mountedId: string | null = null

// Save/restore the scroll position across a `fit()` (which reflows and can shift
// viewportY). The key distinction: a viewport pinned to the bottom is *following*
// live output, so after a reflow it should stay glued to the bottom — restoring an
// absolute viewportY there would bump it up into the middle of history. Only when
// the user deliberately scrolled up do we preserve an absolute position.
const saveViewportY = (entry: Entry): void => {
  const buf = entry.term.buffer.active
  entry.savedViewportY = buf.viewportY
  entry.savedAtBottom = buf.viewportY >= buf.baseY
}

const restoreViewportY = (entry: Entry): void => {
  if (entry.savedAtBottom) {
    entry.term.scrollToBottom()
    return
  }
  const delta = entry.savedViewportY - entry.term.buffer.active.viewportY
  if (delta !== 0) entry.term.scrollLines(delta)
}

const createEntry = (spec: TerminalPaneSpec, d: TerminalRegistryDeps): Entry => {
  const host = document.createElement("div")
  host.className = "term-pane"
  getParkingLot().appendChild(host)

  const term = new Terminal({
    fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
    fontSize: 12,
    scrollback: 10000,
    theme: { background: "#0b0c0e", foreground: "#d7dae0", cursor: "#5b9dff" },
  })
  const fit = new FitAddon()
  term.loadAddon(fit)
  term.open(host)

  const replay = createPreBindBuffer()

  const entry: Entry = {
    id: spec.id,
    term,
    fit,
    host,
    replay,
    sessionId: spec.sessionId,
    // Measure-on-first-show when launching (no session yet) or resuming.
    pendingMeasure: spec.measureOnMount || spec.sessionId === undefined,
    active: false,
    savedViewportY: 0,
    savedAtBottom: true,
    dispose: () => {},
  }

  // Keystrokes out: raw write to whichever session id is currently bound.
  const input = term.onData((data) => {
    if (entry.sessionId) window.arc.ptyWrite(entry.sessionId, data)
  })

  // Data in: one handler, two regimes gated by `replay.flushed`. Before the id
  // binds, capture (keyed by session) so the splash banner isn't dropped; after
  // flush (on bind, see bindSession), render this session's bytes live. Wait for
  // the preload bridge — an entry can be created before `window.arc` attaches.
  const unsub = subscribeWhenReady((arc) =>
    arc.onPtyData((evt) => {
      if (!replay.flushed) {
        replay.capture(evt.sessionId, evt.data)
        return
      }
      if (evt.sessionId === entry.sessionId) {
        term.write(evt.data, traceWrite(evt.sessionId, evt.data))
      }
    }),
  )

  // Refit + resize the PTY only while this host lives in the slot. A parked host
  // sits in the (differently sized) parking lot; resizing it would send a bogus
  // winsize to the child, so skip entirely unless active.
  //
  // Collapsing the right sidebar shrinks the slot to zero width without unmounting
  // (so the host stays active here, not parked). Don't save the scroll position
  // while hidden — the captured viewport is meaningless at zero size and would be
  // restored mid-history on re-show. Instead, treat the zero→visible transition as
  // a fresh show and glue the viewport to the bottom so the terminal re-opens
  // following live output.
  let debounce: ReturnType<typeof setTimeout> | undefined
  let wasHidden = false
  const ro = new ResizeObserver(() => {
    if (debounce) clearTimeout(debounce)
    debounce = setTimeout(() => {
      if (!entry.active) return
      if (host.clientWidth === 0 || host.clientHeight === 0) {
        wasHidden = true
        return
      }
      if (wasHidden) {
        wasHidden = false
        fit.fit()
        term.scrollToBottom()
      } else {
        saveViewportY(entry)
        fit.fit()
        restoreViewportY(entry)
      }
      if (entry.sessionId) {
        traceResize(entry.sessionId, "resize-observer")
        window.arc.ptyResize(entry.sessionId, term.cols, term.rows)
      }
    }, 100)
  })
  ro.observe(host)

  // Re-focus on an explicit shell `focusTerminal` signal (re-selecting the live
  // session, or re-opening a collapsed panel onto it). Only the active entry acts.
  const focusSub = d.shellActor.on("focusTerminal", () => {
    if (entry.active) focusActive(entry)
  })

  entry.dispose = () => {
    if (debounce) clearTimeout(debounce)
    ro.disconnect()
    input.dispose()
    unsub()
    focusSub.unsubscribe()
    term.dispose()
    host.remove()
  }

  return entry
}

// Grab the keyboard and refit after layout settles (a panel expand commits a
// frame after the attach), then repaint so a parked-then-shown screen is solid.
const focusActive = (entry: Entry): void => {
  entry.term.focus()
  requestAnimationFrame(() => {
    saveViewportY(entry)
    entry.fit.fit()
    restoreViewportY(entry)
    entry.term.refresh(0, entry.term.rows - 1)
    entry.term.focus()
    if (entry.sessionId) {
      traceResize(entry.sessionId, "focus-raf")
      window.arc.ptyResize(entry.sessionId, entry.term.cols, entry.term.rows)
    }
  })
}

const parkEntry = (entry: Entry): void => {
  if (entry.active) saveViewportY(entry)
  entry.active = false
  getParkingLot().appendChild(entry.host)
}

const attachEntry = (entry: Entry, target: HTMLElement): void => {
  target.appendChild(entry.host)
  entry.active = true
  // Size to the real slot before measuring/reporting so the child spawns at the
  // pane's true winsize (the parking lot's size must never leak through).
  if (entry.host.clientWidth > 0 && entry.host.clientHeight > 0) {
    saveViewportY(entry)
    entry.fit.fit()
    restoreViewportY(entry)
  }
  if (entry.pendingMeasure) {
    entry.pendingMeasure = false
    deps?.onMeasured(entry.id, entry.term.cols, entry.term.rows)
  } else if (entry.sessionId) {
    traceResize(entry.sessionId, "attach")
    window.arc.ptyResize(entry.sessionId, entry.term.cols, entry.term.rows)
  }
  focusActive(entry)
}

/**
 * Reconcile the slot to (`slot`, `activeId`): park whatever no longer belongs,
 * attach the active entry if one is bound and its xterm exists. Idempotent and
 * order-independent, so it can run after a slot change, an active change, or
 * entry creation without double-work.
 */
const render = (): void => {
  const target = slot && activeId && entries.has(activeId) ? activeId : null
  if (mountedId && mountedId !== target) {
    const prev = entries.get(mountedId)
    if (prev) parkEntry(prev)
  }
  if (target && mountedId !== target && slot) {
    attachEntry(entries.get(target)!, slot)
  }
  mountedId = target
}

/**
 * Bring the registry's entry set in line with the machine's pane list: create
 * lazily, update id bindings (flushing pre-bind replay on a fresh session id),
 * and dispose entries whose pane has truly closed (PTY exit / removal). Call from
 * an always-mounted effect so disposal tracks `panes`, not which surface renders.
 */
export const sync = (specs: ReadonlyArray<TerminalPaneSpec>, d: TerminalRegistryDeps): void => {
  deps = d
  const keep = new Set<string>()
  for (const spec of specs) {
    keep.add(spec.id)
    let entry = entries.get(spec.id)
    if (!entry) {
      entry = createEntry(spec, d)
      entries.set(spec.id, entry)
    }
    bind(entry, spec.sessionId)
  }
  for (const [id, entry] of entries) {
    if (keep.has(id)) continue
    if (mountedId === id) mountedId = null
    entry.dispose()
    entries.delete(id)
  }
  render()
}

// Open the live gate the first time the session id is known, replaying any output
// that beat the bind (the splash banner) and nudging a repaint. The gate is keyed
// on `replay.flushed`, NOT on the id changing: a launch binds its id *after*
// creation (undefined → real), but a resume/adopt knows its id at creation and may
// never change it — gating on change would leave that gate shut, so the data
// handler buffers bytes forever and the terminal stays blank.
const bind = (entry: Entry, sessionId: string | undefined): void => {
  if (sessionId === undefined) {
    entry.sessionId = undefined
    return
  }
  const changed = sessionId !== entry.sessionId
  const wasFlushed = entry.replay.flushed
  entry.sessionId = sessionId
  if (!wasFlushed) {
    entry.replay.flush(sessionId, (data) => entry.term.write(data, traceWrite(sessionId, data)))
  }
  if (changed || !wasFlushed) {
    traceResize(sessionId, "id-bind")
    if (entry.host.clientWidth > 0 && entry.host.clientHeight > 0) entry.fit.fit()
    window.arc.ptyResize(sessionId, entry.term.cols, entry.term.rows)
  }
}

/** The React mount point appeared/disappeared (terminal surface shown/hidden). */
export const setSlot = (el: HTMLElement | null): void => {
  slot = el
  render()
}

/** Which pane should be visible — `null` shows none (detached overlay / empty). */
export const setActive = (paneId: string | null): void => {
  if (activeId === paneId) return
  activeId = paneId
  render()
}
