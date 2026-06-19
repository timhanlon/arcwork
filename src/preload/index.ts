import { contextBridge, ipcRenderer } from "electron"
import { RPC_CHANNEL, RPC_REPLY_CHANNEL } from "../shared/rpc.js"
import type { AssistantStreamDelta } from "../shared/assistant-stream.js"

type PtyData = { sessionId: string; data: string }
type PtyExit = { sessionId: string; exitCode: number }

/**
 * Bridge. Control plane: the RPC transport — `rpcSend` ships an encoded client
 * message to main, `onRpcMessage` subscribes to encoded server replies; the
 * renderer client (`rpc-client.ts`) drives both. Data plane: `onPtyData` /
 * `onPtyExit` subscriptions and `ptyWrite` for raw keystrokes.
 */
contextBridge.exposeInMainWorld("arc", {
  /**
   * Which build is this — `dev` (`pnpm dev`) or `stable` (built/preview)? The
   * main process stamps `ARC_PROFILE` before any window opens, and this preload
   * runs with Node access (`sandbox: false`), so we can read it synchronously.
   * macOS keeps the unpackaged binary named "Electron", so the renderer uses
   * this to label the window itself.
   */
  profile: process.env["ARC_PROFILE"] === "dev" ? "dev" : "stable",

  /** Dev-only PTY burst tracing flag (main stamps `ARC_PTY_TRACE`). Lets the
   * renderer half of the trace (term.write metrics, resize call sites) match the
   * main-side `pty-trace` aggregation. See pty-trace.ts. */
  ptyTrace: process.env["ARC_PTY_TRACE"] === "1",

  /** Ship one encoded RPC client message (request/ack) to main. */
  rpcSend: (message: unknown): void => ipcRenderer.send(RPC_CHANNEL, message),

  /** Subscribe to encoded RPC server messages (exits/defects) from main. */
  onRpcMessage: (cb: (message: unknown) => void): (() => void) => {
    const handler = (_e: unknown, message: unknown): void => cb(message)
    ipcRenderer.on(RPC_REPLY_CHANNEL, handler)
    return () => ipcRenderer.removeListener(RPC_REPLY_CHANNEL, handler)
  },

  onPtyData: (cb: (evt: PtyData) => void): (() => void) => {
    const handler = (_e: unknown, evt: PtyData) => cb(evt)
    ipcRenderer.on("arc:pty-data", handler)
    return () => ipcRenderer.removeListener("arc:pty-data", handler)
  },

  onPtyExit: (cb: (evt: PtyExit) => void): (() => void) => {
    const handler = (_e: unknown, evt: PtyExit) => cb(evt)
    ipcRenderer.on("arc:pty-exit", handler)
    return () => ipcRenderer.removeListener("arc:pty-exit", handler)
  },

  /** Ephemeral live assistant tokens for the in-flight turn (Claude only).
   * Render-only — never persisted; the durable bubble lands from the transcript. */
  onAssistantStream: (cb: (delta: AssistantStreamDelta) => void): (() => void) => {
    const handler = (_e: unknown, delta: AssistantStreamDelta) => cb(delta)
    ipcRenderer.on("arc:assistant-stream", handler)
    return () => ipcRenderer.removeListener("arc:assistant-stream", handler)
  },

  ptyWrite: (sessionId: string, data: string): void =>
    ipcRenderer.send("arc:pty-write", { sessionId, data }),

  ptyResize: (sessionId: string, cols: number, rows: number): void =>
    ipcRenderer.send("arc:pty-resize", { sessionId, cols, rows }),

  /** Observability: report PTY bytes that arrived for a session *before* its id
   * bound and were recovered — buffered, then replayed into the terminal on bind
   * (the splash banner). Main logs these as `arc.pty.replayed` for Lensflare. */
  ptyReportReplayed: (sessionId: string, bytes: number, chunks: number): void =>
    ipcRenderer.send("arc:pty-replayed", { sessionId, bytes, chunks }),

  /** Observability: report PTY bytes genuinely lost before id-bind — output that
   * overflowed the pre-bind replay buffer's per-session cap. Healthy launches
   * report none. Main logs these as `arc.pty.dropped` for Lensflare. */
  ptyReportDropped: (sessionId: string, bytes: number, chunks: number): void =>
    ipcRenderer.send("arc:pty-dropped", { sessionId, bytes, chunks }),
})
