/**
 * Dev-only renderer half of PTY tracing — the counterpart to
 * main/services/pty-trace.ts. Gated on `window.arc.ptyTrace` (main stamps
 * `ARC_PTY_TRACE` and the preload forwards it).
 *
 * Measures what the renderer does with the burst the main side sent: how many
 * `term.write` calls land, their total bytes, and the drain time (write → the
 * xterm parser callback for the LAST write in the window). Resize call sites are
 * logged separately so we can confirm/falsify the "launch fires three
 * SIGWINCHes" theory (work_01kv2cwq4re06bsgm3kztxs69p).
 */

const enabled = (): boolean => Boolean(window.arc?.ptyTrace)

const IDLE_FLUSH_MS = 200

interface Burst {
  writes: number
  bytes: number
  startedAt: number
  lastDrainMs: number
  timer: ReturnType<typeof setTimeout> | null
}

const bursts = new Map<string, Burst>()

const get = (sessionId: string): Burst => {
  let b = bursts.get(sessionId)
  if (!b) {
    b = { writes: 0, bytes: 0, startedAt: performance.now(), lastDrainMs: 0, timer: null }
    bursts.set(sessionId, b)
  }
  return b
}

const flush = (sessionId: string): void => {
  const b = bursts.get(sessionId)
  if (!b) return
  bursts.delete(sessionId)
  if (b.timer) clearTimeout(b.timer)
  const ms = Math.round(performance.now() - b.startedAt)
  // eslint-disable-next-line no-console -- dev-only opt-in trace
  console.log(
    `[pty-trace] renderer session=${sessionId} window=${ms}ms ` +
      `writes=${b.writes} bytes=${b.bytes} lastDrain=${b.lastDrainMs.toFixed(1)}ms`,
  )
}

/**
 * Wrap a `term.write`. Returns the data to pass through plus an optional callback
 * the caller hands to `term.write(data, cb)` so we can time the parser drain.
 */
export const traceWrite = (sessionId: string, data: string): (() => void) | undefined => {
  if (!enabled()) return undefined
  const b = get(sessionId)
  b.writes += 1
  b.bytes += data.length
  const at = performance.now()
  if (b.timer) clearTimeout(b.timer)
  b.timer = setTimeout(() => flush(sessionId), IDLE_FLUSH_MS)
  return () => {
    const cur = bursts.get(sessionId)
    if (cur) cur.lastDrainMs = performance.now() - at
  }
}

/** Log a `ptyResize` call site so launch-time SIGWINCH volume is visible. */
export const traceResize = (sessionId: string | undefined, label: string): void => {
  if (!enabled()) return
  // eslint-disable-next-line no-console -- dev-only opt-in trace
  console.log(`[pty-trace] renderer resize session=${sessionId ?? "<unbound>"} site=${label}`)
}
