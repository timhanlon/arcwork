import type { AssistantStreamDelta } from "../../shared/assistant-stream.js"



declare global {
  interface Window {
    arc: {
      profile: "dev" | "stable"
      home: string
      ptyTrace: boolean
      rpcSend: (message: unknown) => void
      onRpcMessage: (cb: (message: unknown) => void) => () => void
      onPtyData: (cb: (evt: { sessionId: TargetId; data: string }) => void) => () => void
      onPtyExit: (cb: (evt: { sessionId: TargetId; exitCode: number }) => void) => () => void
      onAssistantStream: (cb: (delta: AssistantStreamDelta) => void) => () => void
      ptyWrite: (sessionId: TargetId, data: string) => void
      ptyResize: (sessionId: TargetId, cols: number, rows: number) => void
      ptyReportReplayed: (sessionId: TargetId, bytes: number, chunks: number) => void
      ptyReportDropped: (sessionId: TargetId, bytes: number, chunks: number) => void
    }
  }
}
