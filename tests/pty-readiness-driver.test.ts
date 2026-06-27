import { Effect, Option, Queue } from "effect"
import { EventEmitter } from "node:events"
import type { IPty } from "node-pty"
import * as pty from "node-pty"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { TargetSession } from "../src/shared/instance.js"
import { arcId } from "../src/shared/ids.js"
import { PTY_SUBMIT_SEQUENCE } from "../src/main/pty-submit.js"
import {
  drivePtySpawn,
  type FirstOutput,
  type PtyExit,
  type PtySpawnContext,
  type SpawnOptions,
} from "../src/main/services/target-session/pty-readiness-driver.js"

// drivePtySpawn is the spawn state machine the TargetSessionManager runs inside
// `Effect.sync`: it owns seeded-prompt delivery gated on the ready glyph, the
// fallback timer, pre-session gate clearing, first-output telemetry, and the
// exit handoff. The decomposition made it a plain synchronous function over
// injected maps/queues + a `pty.spawn` child, so the whole machine is drivable
// here with a fake child — no live CLI launch. (Manager wiring still rests on
// typecheck; this covers the protocol logic the agent flagged as unproven.)

vi.mock("node-pty", () => ({ spawn: vi.fn() }))

interface FakeChild {
  readonly writes: Array<string>
  readonly fire: (data: string) => void
  readonly exit: (code: number) => void
  readonly write: (d: string) => void
  readonly onData: (cb: (d: string) => void) => void
  readonly onExit: (cb: (e: { exitCode: number }) => void) => void
}

const makeFakeChild = (): FakeChild => {
  let dataCb: (d: string) => void = () => {}
  let exitCb: (e: { exitCode: number }) => void = () => {}
  const writes: Array<string> = []
  return {
    writes,
    write: (d) => void writes.push(d),
    onData: (cb) => void (dataCb = cb),
    onExit: (cb) => void (exitCb = cb),
    fire: (data) => dataCb(data),
    exit: (code) => exitCb({ exitCode: code }),
  }
}

const session: TargetSession = {
  _tag: "TargetSession",
  id: arcId("target", "target_test"),
  provider: "claude",
  origin: "manual",
  chatId: arcId("chat", "chat_test"),
  cwd: "/tmp/arc-test",
  attached: false,
  state: "unknown",
  startedAt: "2026-01-01T00:00:00.000Z",
}

const baseOpts = (o: Partial<SpawnOptions> = {}): SpawnOptions => ({
  launchCmd: "claude",
  args: [],
  cols: 80,
  rows: 24,
  sockPath: "/tmp/arc-hook.sock",
  ...o,
})

const drain = <A>(q: Queue.Dequeue<A>): Array<A> => {
  const out: Array<A> = []
  for (;;) {
    const next = Effect.runSync(Queue.poll(q))
    if (Option.isNone(next)) break
    out.push(next.value)
  }
  return out
}

describe("drivePtySpawn", () => {
  let child: FakeChild
  let ctx: PtySpawnContext
  let firstOutputs: Queue.Queue<FirstOutput>
  let exits: Queue.Queue<PtyExit>

  beforeEach(() => {
    vi.useFakeTimers()
    child = makeFakeChild()
    vi.mocked(pty.spawn).mockReturnValue(child as unknown as IPty)
    firstOutputs = Effect.runSync(Queue.make<FirstOutput>())
    exits = Effect.runSync(Queue.make<PtyExit>())
    ctx = {
      ptys: new Map(),
      promptWriters: new Map(),
      events: new EventEmitter(),
      firstOutputs,
      exits,
      dbPath: "/tmp/arc.sqlite",
    }
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.clearAllMocks()
  })

  const countWrites = (text: string): number => child.writes.filter((w) => w === text).length

  it("registers the child + prompt writer, holding the seeded prompt until the ready glyph", () => {
    drivePtySpawn(ctx, session, baseOpts({ writeAfterStart: "GO", readyGlyph: "❯" }), 0)

    expect(ctx.ptys.get(session.id)).toBe(child)
    expect(ctx.promptWriters.has(session.id)).toBe(true)

    child.fire("booting...\n")
    expect(countWrites("GO")).toBe(0) // glyph not seen yet → still withheld

    child.fire("❯ ")
    expect(countWrites("GO")).toBe(1)
  })

  it("delivers the seeded prompt exactly once even if the glyph repeats", () => {
    drivePtySpawn(ctx, session, baseOpts({ writeAfterStart: "GO", readyGlyph: "❯" }), 0)
    child.fire("❯ ")
    child.fire("❯ ")
    expect(countWrites("GO")).toBe(1)
  })

  it("delivers via the fallback timer when the glyph never shows", () => {
    drivePtySpawn(ctx, session, baseOpts({ writeAfterStart: "GO", readyGlyph: "❯" }), 0)
    expect(countWrites("GO")).toBe(0)
    vi.advanceTimersByTime(10_000) // READY_FALLBACK_MS
    expect(countWrites("GO")).toBe(1)
  })

  it("delivers an rpc-jsonl prompt immediately as a command line, no readiness wait", () => {
    drivePtySpawn(
      ctx,
      session,
      baseOpts({ writeAfterStart: "GO", promptInjectionMode: "rpc-jsonl" }),
      0,
    )
    expect(child.writes).toContain(JSON.stringify({ type: "prompt", message: "GO" }) + "\n")
  })

  it("clears a pre-session gate once, then waits for the glyph before the prompt", () => {
    drivePtySpawn(
      ctx,
      session,
      baseOpts({
        writeAfterStart: "GO",
        readyGlyph: "❯",
        advanceGates: [{ match: "trust this folder?", key: "y\r" }],
      }),
      0,
    )

    child.fire("Do you trust this folder? (y/n) ")
    expect(countWrites("y\r")).toBe(1)
    expect(countWrites("GO")).toBe(0) // gate cleared, prompt still withheld

    child.fire("❯ ")
    expect(countWrites("GO")).toBe(1)
    expect(countWrites("y\r")).toBe(1) // gate not re-sent
  })

  it("submits a prefilled draft with a bare Enter after the settle delay", () => {
    drivePtySpawn(ctx, session, baseOpts({ submitSeededAfterReady: true, readyGlyph: "❯" }), 0)
    child.fire("❯ ")
    expect(countWrites(PTY_SUBMIT_SEQUENCE)).toBe(0) // settle delay not elapsed
    vi.advanceTimersByTime(400) // PREFILL_SUBMIT_SETTLE_MS
    expect(countWrites(PTY_SUBMIT_SEQUENCE)).toBe(1)
  })

  it("emits one first-output telemetry record sized to the first chunk only", () => {
    drivePtySpawn(ctx, session, baseOpts(), 7)
    child.fire("AB")
    child.fire("CDE")

    const records = drain(firstOutputs)
    expect(records).toHaveLength(1)
    expect(records[0]).toMatchObject({
      sessionId: session.id,
      provider: session.provider,
      spawnedAt: 7,
      firstChunkBytes: 2,
    })
  })

  it("relays PTY data to the events emitter", () => {
    const seen: Array<{ sessionId: string; data: string }> = []
    ctx.events.on("data", (e) => seen.push(e))
    drivePtySpawn(ctx, session, baseOpts(), 0)
    child.fire("hello")
    expect(seen).toEqual([{ sessionId: session.id, data: "hello" }])
  })

  it("hands the exit off to the exits queue", () => {
    drivePtySpawn(ctx, session, baseOpts(), 0)
    child.exit(137)
    expect(drain(exits)).toEqual([{ sessionId: session.id, exitCode: 137 }])
  })
})
