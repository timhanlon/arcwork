import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
  PTY_SUBMIT_DELAY_MS,
  PTY_SUBMIT_SEQUENCE,
  writePromptWithDelayedSubmit,
} from "../src/main/pty-submit.js"

describe("writePromptWithDelayedSubmit", () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it("writes prompt text immediately and submit after the default delay", () => {
    const writes: Array<string> = []
    writePromptWithDelayedSubmit((data) => writes.push(data), "hello\nworld")

    expect(writes).toEqual(["hello\nworld"])
    vi.advanceTimersByTime(PTY_SUBMIT_DELAY_MS - 1)
    expect(writes).toEqual(["hello\nworld"])

    vi.advanceTimersByTime(1)
    expect(writes).toEqual(["hello\nworld", PTY_SUBMIT_SEQUENCE])
  })

  it("allows tuning delay and submit sequence", () => {
    const writes: Array<string> = []
    writePromptWithDelayedSubmit((data) => writes.push(data), "x", {
      delayMs: 120,
      submit: "\n",
    })

    vi.advanceTimersByTime(119)
    expect(writes).toEqual(["x"])
    vi.advanceTimersByTime(1)
    expect(writes).toEqual(["x", "\n"])
  })
})
