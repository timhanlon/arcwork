import type { TargetId } from "../../../shared/ids.js"
/**
 * Pre-bind PTY replay buffer (per pane).
 *
 * A target's splash banner is the child's first PTY output; on launch it can
 * arrive at the renderer *before* the `LaunchTarget` RPC returns the id that a
 * `TerminalPane` gates its writes on (see Terminal.tsx). Historically those
 * bytes were written to no terminal and lost — the SIGWINCH repaint on id-bind
 * recovers the live TUI frame but not a one-shot banner already in scrollback.
 *
 * This buffer closes that race entirely, on the renderer side, where the drop
 * happens. Each pane owns one buffer. Until the pane's id binds, every PTY data
 * event the pane receives is *captured* (keyed by session id, so a chatty
 * background session can't crowd out our banner). When the id binds, the pane
 * `flush`es: the bytes captured for that id are written into the terminal in
 * arrival order, then the buffer is retired and live rendering takes over.
 *
 * Exactly-once by construction: the pane routes every data event through one
 * handler that consults {@link PreBindBuffer.flushed}. Before flush, all events
 * are captured and none rendered live; `flush` writes the captured bytes and
 * flips the gate synchronously; after flush, events render live. The transition
 * is atomic (single-threaded), so no byte is both replayed and rendered live,
 * and none is dropped at the seam.
 *
 * Reporting (per the project's main-process observability convention): on flush
 * the buffer reports recovered bytes as `arc.pty.replayed` and any overflow
 * (bytes that exceeded the per-session cap and were genuinely lost) as
 * `arc.pty.dropped`. A healthy launch reports replayed > 0 and dropped 0.
 */

/** Shared encoder for UTF-8 byte counting (matches main's Buffer.byteLength). */
const encoder = new TextEncoder()

/**
 * Max bytes buffered per session before id-bind. The splash banner is a few KB;
 * this is generous headroom so a normal launch never overflows. Per-session (not
 * global) so a busy background session's stream can't evict our banner. Bytes
 * beyond the cap are counted as genuinely dropped rather than buffered.
 */
const PER_SESSION_CAP_BYTES = 256 * 1024

interface Captured {
  readonly chunks: Array<string>
  bytes: number
  droppedBytes: number
  droppedChunks: number
}

export interface PreBindBuffer {
  /** True once {@link flush} has run; the pane renders live from then on. */
  readonly flushed: boolean
  /** Capture a pre-bind data event (bounded per session). No-op after flush. */
  capture: (sessionId: TargetId, data: string) => void
  /**
   * Bind: write the bytes captured for `sessionId` (in arrival order) via
   * `write`, report recovery/overflow, then retire the buffer. Idempotent.
   */
  flush: (sessionId: TargetId, write: (data: string) => void) => void
}

export const createPreBindBuffer = (): PreBindBuffer => {
  const captured = new Map<string, Captured>()
  let flushed = false

  return {
    get flushed() {
      return flushed
    },
    capture(sessionId, data) {
      if (flushed) return
      let entry = captured.get(sessionId)
      if (!entry) {
        entry = { chunks: [], bytes: 0, droppedBytes: 0, droppedChunks: 0 }
        captured.set(sessionId, entry)
      }
      const n = encoder.encode(data).byteLength
      if (entry.bytes + n > PER_SESSION_CAP_BYTES) {
        entry.droppedBytes += n
        entry.droppedChunks += 1
        return
      }
      entry.chunks.push(data)
      entry.bytes += n
    },
    flush(sessionId, write) {
      if (flushed) return
      flushed = true
      const entry = captured.get(sessionId)
      captured.clear()
      if (!entry) return
      for (const chunk of entry.chunks) write(chunk)
      if (entry.bytes > 0) {
        window.arc.ptyReportReplayed(sessionId, entry.bytes, entry.chunks.length)
      }
      if (entry.droppedBytes > 0) {
        window.arc.ptyReportDropped(sessionId, entry.droppedBytes, entry.droppedChunks)
      }
    },
  }
}
