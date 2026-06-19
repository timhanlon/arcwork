import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { createPreBindBuffer } from "../src/renderer/src/terminal/ptyReplayBuffer.js"

/**
 * The pre-bind replay buffer recovers PTY output that arrives before a pane's
 * session id binds (the splash banner). These tests pin the two properties that
 * make it correct: it replays only the bound session's bytes in arrival order,
 * and the flush is exactly-once (capture → flush → live is a clean cutover with
 * no double-write and no loss at the seam).
 */

const replayed = vi.fn()
const dropped = vi.fn()

beforeEach(() => {
  replayed.mockReset()
  dropped.mockReset()
  // The buffer reports recovery/overflow through the preload bridge.
  ;(globalThis as { window?: unknown }).window = {
    arc: { ptyReportReplayed: replayed, ptyReportDropped: dropped },
  }
})

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe("pre-bind replay buffer", () => {
  it("replays only the bound session's bytes, in arrival order", () => {
    const buf = createPreBindBuffer()
    buf.capture("s1", "A")
    buf.capture("s2", "other") // a background session's output — must not leak
    buf.capture("s1", "B")
    buf.capture("s1", "C")

    const written: Array<string> = []
    buf.flush("s1", (d) => written.push(d))

    expect(written).toEqual(["A", "B", "C"])
    expect(replayed).toHaveBeenCalledWith("s1", 3, 3)
    expect(dropped).not.toHaveBeenCalled()
  })

  it("captures nothing once flushed (live takes over) and flush is idempotent", () => {
    const buf = createPreBindBuffer()
    buf.capture("s1", "pre")

    const written: Array<string> = []
    buf.flush("s1", (d) => written.push(d))
    expect(buf.flushed).toBe(true)

    // Post-flush events are the caller's to render live; the buffer ignores them.
    buf.capture("s1", "post")
    // A second flush replays nothing and re-reports nothing.
    buf.flush("s1", (d) => written.push(d))

    expect(written).toEqual(["pre"])
    expect(replayed).toHaveBeenCalledTimes(1)
  })

  it("binding a session with no pre-bind output replays nothing (healthy case)", () => {
    const buf = createPreBindBuffer()
    const written: Array<string> = []
    buf.flush("s1", (d) => written.push(d))

    expect(written).toEqual([])
    expect(replayed).not.toHaveBeenCalled()
    expect(dropped).not.toHaveBeenCalled()
  })

  it("counts bytes beyond the per-session cap as dropped, keeping the earliest", () => {
    const buf = createPreBindBuffer()
    const chunk = "x".repeat(200 * 1024) // 200 KiB; cap is 256 KiB
    buf.capture("s1", chunk) // fits (200 KiB)
    buf.capture("s1", chunk) // would exceed cap → dropped whole

    const written: Array<string> = []
    buf.flush("s1", (d) => written.push(d))

    expect(written).toEqual([chunk]) // only the first, earliest chunk survives
    expect(replayed).toHaveBeenCalledWith("s1", 200 * 1024, 1)
    expect(dropped).toHaveBeenCalledWith("s1", 200 * 1024, 1)
  })

  it("counts UTF-8 bytes, not UTF-16 code units", () => {
    const buf = createPreBindBuffer()
    buf.capture("s1", "✓") // 3 bytes UTF-8, 1 code unit
    buf.flush("s1", () => {})
    expect(replayed).toHaveBeenCalledWith("s1", 3, 1)
  })
})
