/**
 * Dev-only PTY burst tracing. Gated on `ARC_PTY_TRACE=1`.
 *
 * Baselines the start/stop unresponsiveness before/after output coalescing
 * (work_01kv2cwq4re06bsgm3kztxs69p): we need the burst *shape*, not a per-chunk
 * log that is itself a flood. So we aggregate per session over an idle-delimited
 * window and emit one line when the burst settles.
 *
 * Two perspectives accumulate into the same window so they line up:
 *  - `onData` chunks: what node-pty handed us (chunk count, bytes, max chunk).
 *  - `arc:pty-data` sends: what actually crossed IPC to the renderer.
 * Today these are 1:1 (one send per chunk); after coalescing they should be N:1,
 * and this trace is how we confirm it.
 */

export const PTY_TRACE_ENABLED = process.env["ARC_PTY_TRACE"] === "1"

/** A burst is "over" once this much wall-clock passes with no chunk or send. */
const IDLE_FLUSH_MS = 200

interface Burst {
  chunks: number
  chunkBytes: number
  maxChunk: number
  sends: number
  sendBytes: number
  startedAt: number
  timer: ReturnType<typeof setTimeout> | null
}

const bursts = new Map<string, Burst>()

const get = (sessionId: string): Burst => {
  let b = bursts.get(sessionId)
  if (!b) {
    b = {
      chunks: 0,
      chunkBytes: 0,
      maxChunk: 0,
      sends: 0,
      sendBytes: 0,
      startedAt: Date.now(),
      timer: null,
    }
    bursts.set(sessionId, b)
  }
  return b
}

const arm = (sessionId: string, b: Burst): void => {
  if (b.timer) clearTimeout(b.timer)
  b.timer = setTimeout(() => flush(sessionId), IDLE_FLUSH_MS)
  b.timer.unref?.()
}

const flush = (sessionId: string): void => {
  const b = bursts.get(sessionId)
  if (!b) return
  bursts.delete(sessionId)
  if (b.timer) clearTimeout(b.timer)
  const ms = Date.now() - b.startedAt
  // eslint-disable-next-line no-console -- dev-only opt-in trace
  console.log(
    `[pty-trace] main session=${sessionId} window=${ms}ms ` +
      `onData{chunks=${b.chunks} bytes=${b.chunkBytes} max=${b.maxChunk}} ` +
      `ipc{sends=${b.sends} bytes=${b.sendBytes}}`,
  )
}

/** Record one raw node-pty `onData` chunk (before any coalescing). */
export const tracePtyChunk = (sessionId: string, data: string): void => {
  if (!PTY_TRACE_ENABLED) return
  const b = get(sessionId)
  const bytes = Buffer.byteLength(data, "utf8")
  b.chunks += 1
  b.chunkBytes += bytes
  if (bytes > b.maxChunk) b.maxChunk = bytes
  arm(sessionId, b)
}

/** Record one `arc:pty-data` IPC broadcast (what crosses to the renderer). */
export const tracePtySend = (sessionId: string, data: string): void => {
  if (!PTY_TRACE_ENABLED) return
  const b = get(sessionId)
  b.sends += 1
  b.sendBytes += Buffer.byteLength(data, "utf8")
  arm(sessionId, b)
}
