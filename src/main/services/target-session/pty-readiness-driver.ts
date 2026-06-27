import { Queue } from "effect"
import type { EventEmitter } from "node:events"
import * as pty from "node-pty"
import type { IPty } from "node-pty"
import type { TargetSession } from "../../../shared/instance.js"
import { arcEnvTags } from "../../../shared/env-tags.js"
import { ARC_HOOK_HELPER_ENV, ARC_HOOK_SOCK_ENV, arcOwnedHelperFile } from "../../hooks/signals.js"
import { PTY_SUBMIT_SEQUENCE, writePromptWithDelayedSubmit } from "../../pty-submit.js"
import { tracePtyChunk } from "../pty-trace.js"

/**
 * Once the session is ready (its prompt glyph showed, or first output as a
 * fallback), how long to wait before sending Enter on a prefilled draft. The
 * composer needs a beat to render the seeded text before it'll accept submit.
 */
const PREFILL_SUBMIT_SETTLE_MS = 400

/**
 * If a provider's prompt glyph never appears (a glyph mismatch, a CLI that
 * draws its prompt differently, or no glyph configured), deliver the seeded
 * prompt anyway after this long — better a slightly-early submit than a session
 * that strands its prompt forever.
 */
const READY_FALLBACK_MS = 10_000

/** Cap on the rolling PTY tail we scan for the readiness glyph. */
const READY_TAIL_CHARS = 4000

/** True once the provider's ready glyph appears in the last few lines of output.
 * The glyph is a printable char that never occurs inside an escape sequence, so a
 * plain substring test needs no ANSI stripping; newline split scopes it to the tail. */
const tailShowsGlyph = (tail: string, glyph: string): boolean =>
  tail
    .split(/\r?\n/)
    .slice(-5)
    .some((line) => line.includes(glyph))

/** Everything `drivePtySpawn` needs beyond the session itself. An options object
 * (not a positional tail) so call sites read by name — launch and resume diverge
 * only in a few fields, and `undefined, {}, false` in argument position hid that. */
export interface SpawnOptions {
  readonly launchCmd: string
  readonly args: ReadonlyArray<string>
  readonly cols: number | undefined
  readonly rows: number | undefined
  readonly sockPath: string
  readonly writeAfterStart?: string
  readonly extraEnv?: Readonly<Record<string, string>>
  /** When the prompt was *seeded* (prefill) rather than submitted, submit it
   * once the session is ready (its prompt glyph appears). */
  readonly submitSeededAfterReady?: boolean
  /** The CLI's input-prompt glyph; we hold the seeded prompt's paste/submit
   * until it shows in recent output, so the agent's first turn has its MCP tools
   * connected. Absent → first PTY output is the readiness signal. */
  readonly readyGlyph?: string
  /** How prompts reach this CLI: terminal paste+Enter, or a JSONL command line
   * (rpc providers). Determines both the seeded-prompt and inbox wire format. */
  readonly promptInjectionMode?: string
  /** Pre-session gates to clear before the ready glyph can appear (cursor's
   * workspace-trust / login screens): send each gate's key once when its match
   * string shows in output. */
  readonly advanceGates?: ReadonlyArray<{ readonly match: string; readonly key: string }>
}

/** First-output observability. The splash banner is the child's very first PTY
 * write; on launch it can race ahead of the `LaunchTarget` RPC that binds the
 * session id in the renderer, so the renderer drops it (Terminal.tsx gates on a
 * known id). To see that race in Lensflare we record, per launch, how long after
 * spawn the first byte arrived and how big that first burst was. */
export interface FirstOutput {
  readonly sessionId: string
  readonly provider: string
  readonly spawnedAt: number
  readonly firstChunkBytes: number
}

/** A PTY child's exit, handed off from node-pty's raw `onExit` callback to the
 * manager's scoped consumer (no Effect runs from the callback). */
export interface PtyExit {
  readonly sessionId: string
  readonly exitCode: number
}

/** The live closure handles `drivePtySpawn` mutates: the manager's PTY/prompt
 * maps and the queues its scoped fibers drain. Passed in so the spawn body stays
 * pure terminal-protocol logic with no Effect dependency. */
export interface PtySpawnContext {
  readonly ptys: Map<string, IPty>
  readonly promptWriters: Map<string, (text: string) => void>
  readonly events: EventEmitter
  readonly firstOutputs: Queue.Queue<FirstOutput>
  readonly exits: Queue.Queue<PtyExit>
  readonly dbPath: string
}

/**
 * Spawn the child PTY and wire its whole terminal-protocol lifecycle: env +
 * winsize, the per-session prompt writer, seeded-prompt delivery gated on the
 * ready glyph (with a fallback timer and pre-session gate clearing),
 * first-output telemetry, the data→renderer relay, and the exit handoff. A
 * synchronous side-effecting function (run inside `Effect.sync` by the manager);
 * it mutates the passed-in maps/queues rather than holding any Effect.
 */
export const drivePtySpawn = (
  ctx: PtySpawnContext,
  session: TargetSession,
  opts: SpawnOptions,
  spawnedAt: number,
): void => {
  const { ptys, promptWriters, events, firstOutputs, exits, dbPath } = ctx
  const {
    launchCmd,
    args,
    cols,
    rows,
    sockPath,
    writeAfterStart,
    extraEnv = {},
    submitSeededAfterReady = false,
    readyGlyph,
    promptInjectionMode,
    advanceGates = [],
  } = opts
  const child = pty.spawn(launchCmd, [...args], {
    name: "xterm-color",
    cols: cols && cols > 0 ? Math.floor(cols) : 80,
    rows: rows && rows > 0 ? Math.floor(rows) : 24,
    cwd: session.cwd,
    env: {
      ...process.env,
      ...arcEnvTags({
        chatId: session.chatId,
        targetSessionId: session.id,
        provider: session.provider,
        dbPath,
      }),
      ...extraEnv,
      [ARC_HOOK_SOCK_ENV]: sockPath,
      // The Arc-owned helper to invoke (provider hooks + the git
      // post-commit hook both read this rather than a repo-local path).
      [ARC_HOOK_HELPER_ENV]: arcOwnedHelperFile(),
    } as Record<string, string>,
  })
  // How to write a prompt to this child: a JSONL command line for rpc
  // providers (pi stays resident and takes `{"type":"prompt",…}` lines), or
  // terminal paste+Enter otherwise. Stored per session so the inbox/submit
  // path reuses the exact wire format. The agent stays attached either way.
  const writePrompt =
    promptInjectionMode === "rpc-jsonl"
      ? (text: string) => child.write(JSON.stringify({ type: "prompt", message: text }) + "\n")
      : (text: string) => writePromptWithDelayedSubmit((d) => child.write(d), text)
  promptWriters.set(session.id, writePrompt)

  // Deliver the seeded prompt exactly once, when the session is ready:
  // paste-then-submit / a JSONL command for stdin providers, a bare Enter
  // for a prefilled draft. Gated on the ready glyph so MCP has connected by
  // turn 1.
  const hasSeededPrompt = Boolean(writeAfterStart) || submitSeededAfterReady
  let delivered = false
  const deliver = () => {
    if (delivered) return
    delivered = true
    clearTimeout(readyFallback)
    if (writeAfterStart) {
      writePrompt(writeAfterStart)
    } else if (submitSeededAfterReady) {
      setTimeout(() => {
        try {
          child.write(PTY_SUBMIT_SEQUENCE)
        } catch {
          /* child gone before submit — nothing to do */
        }
      }, PREFILL_SUBMIT_SETTLE_MS)
    }
  }
  // Fallback so a glyph mismatch or a quiet CLI never strands the prompt.
  const readyFallback = hasSeededPrompt ? setTimeout(deliver, READY_FALLBACK_MS) : undefined
  // An rpc provider reads stdin commands from process start and emits nothing
  // until prompted, so there's no readiness output to wait for — deliver the
  // seeded prompt now (the pty buffers it until pi's reader is up).
  if (hasSeededPrompt && promptInjectionMode === "rpc-jsonl") deliver()

  let firstChunkSeen = false
  let readyTail = ""
  const gatesLeft = [...advanceGates]
  child.onData((data) => {
    tracePtyChunk(session.id, data)
    if (!firstChunkSeen) {
      firstChunkSeen = true
      Queue.offerUnsafe(firstOutputs, {
        sessionId: session.id,
        provider: session.provider,
        spawnedAt,
        firstChunkBytes: Buffer.byteLength(data, "utf8"),
      })
    }
    events.emit("data", { sessionId: session.id, data })
    // Clearing a gate matters even with no seeded prompt (a resumed session
    // must still reach its ready prompt for later inbox sends), so this
    // watch runs whenever there's a prompt to deliver OR a gate left to clear.
    if (!delivered && (hasSeededPrompt || gatesLeft.length > 0)) {
      readyTail = (readyTail + data).slice(-READY_TAIL_CHARS)
      // A pre-session gate (cursor's trust / login screen) blocks the ready
      // glyph from ever appearing — send its key once, then keep watching
      // the (reset) tail for the next gate or the glyph.
      const gateIdx = gatesLeft.findIndex((g) => readyTail.includes(g.match))
      if (gateIdx !== -1) {
        const [gate] = gatesLeft.splice(gateIdx, 1)
        readyTail = ""
        try {
          child.write(gate!.key)
        } catch {
          /* child gone before the gate could be cleared */
        }
        return
      }
      // No glyph configured → first output is our readiness signal.
      if (hasSeededPrompt && (!readyGlyph || tailShowsGlyph(readyTail, readyGlyph))) deliver()
    }
  })
  // Hand the exit off to the scoped consumer; no Effect runs from this
  // raw node-pty callback. `offerUnsafe` is a no-op once the queue is shut
  // down (scope close), so a child killed during app-quit disposal simply
  // isn't reprocessed — consistent with not persisting "exited" on a hard kill.
  child.onExit(({ exitCode }) => {
    clearTimeout(readyFallback)
    Queue.offerUnsafe(exits, { sessionId: session.id, exitCode })
  })
  ptys.set(session.id, child)
}
