import type { AssistantStreamDelta } from "../../shared/assistant-stream.js"



declare global {
  interface Window {
    arc: {
      profile: "dev" | "stable"
      ptyTrace: boolean
      rpcSend: (message: unknown) => void
      onRpcMessage: (cb: (message: unknown) => void) => () => void
      onPtyData: (cb: (evt: { sessionId: string; data: string }) => void) => () => void
      onPtyExit: (cb: (evt: { sessionId: string; exitCode: number }) => void) => () => void
      onAssistantStream: (cb: (delta: AssistantStreamDelta) => void) => () => void
      ptyWrite: (sessionId: string, data: string) => void
      ptyResize: (sessionId: string, cols: number, rows: number) => void
      ptyReportReplayed: (sessionId: string, bytes: number, chunks: number) => void
      ptyReportDropped: (sessionId: string, bytes: number, chunks: number) => void
    }
  }
}
