import type { DiagnosticRow, ExtractedRows } from "../../db/schema.js"
import type { Rec } from "../../extract/json.js"
import { SessionRowBuilder } from "../../extract/session-row-builder.js"
import { classifyTool } from "../../extract/tool-kind.js"

/**
 * The driver's accumulated, session-cumulative item list — the contract between
 * the ACP driver's `session/update` fold and this normalizer. The driver has
 * already done the ACP-specific work (buffering `agent_message_chunk` deltas
 * into one message, upserting `tool_call` / `tool_call_update` by `toolCallId`,
 * synthesizing the user message from the prompt text since ACP does not echo
 * it), so each item here maps to exactly one row — the same shape
 * `codex-appserver/normalize.ts` produces, just pre-folded.
 */
export type AcpItem =
  | { readonly kind: "message"; readonly role: "user" | "assistant"; readonly text: string }
  | {
      readonly kind: "tool"
      readonly toolCallId: string
      /** ACP tool title, e.g. "`echo hello-acp`". */
      readonly title: string | null
      /** ACP `kind`, e.g. "execute" for a shell command. */
      readonly toolKind: string | null
      /** `rawInput.command` for an execute tool. */
      readonly command: string | null
      /** `rawOutput.exitCode` for an execute tool. */
      readonly exitCode: number | null
      /** Combined stdout+stderr for an execute tool; stringified `rawOutput` otherwise. */
      readonly output: string | null
      /** Decoded `rawInput`, for file-hint derivation + the tool row `inputJson`. */
      readonly input: Rec | null
    }

export interface AcpNormalizeOptions {
  /** The ACP session id — the native session id for the `cursor` provider. */
  readonly nativeSessionId: string
  readonly workspaceRoot: string
  /** A stable handle for this live session (`acp:<sessionId>`). */
  readonly sourcePath: string
  readonly model?: string | null
  readonly title?: string
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

/** A completed exec's output, prefixed `[exit N]` on failure (mirrors codex-appserver). */
const execOutput = (item: Extract<AcpItem, { kind: "tool" }>): string => {
  const body = item.output ?? ""
  return item.exitCode != null && item.exitCode !== 0 ? `[exit ${item.exitCode}]\n${body}` : body
}

/**
 * Fold the ACP driver's accumulated {@link AcpItem}s into database-shaped rows —
 * the same {@link ExtractedRows} the rollout-file provider produces, via the same
 * {@link SessionRowBuilder}. The live-transport counterpart to
 * `normalizeAppServerThread`: an execute tool becomes a first-class `shell` row
 * carrying its command + exit code + output (no wrapper regex to strip), and any
 * other tool becomes a generic tool row keyed by its ACP title/kind. No token
 * usage is observed on the ACP wire, so `usageEvents` stays empty.
 */
export const normalizeAcpSession = (
  items: ReadonlyArray<AcpItem>,
  options: AcpNormalizeOptions,
): ExtractedRows => {
  const b = new SessionRowBuilder("cursor", options.nativeSessionId)
  const model = options.model ?? null

  for (const item of items) {
    if (item.kind === "message") {
      if (item.role === "user") {
        b.message({ role: "user", text: item.text })
      } else {
        b.message({ role: "assistant", text: item.text, model })
      }
      continue
    }

    // An execute tool is the shell case (structured command/exit/output); every
    // other tool is a generic row named by its ACP title/kind.
    const isExec = item.toolKind === "execute" || item.command != null
    const name = isExec ? "Shell" : (item.title ?? item.toolKind ?? "tool")
    const row = b.tool({
      name,
      kind: classifyTool("cursor", name),
      nativeToolId: item.toolCallId,
      inputJson: item.input ? JSON.stringify(item.input) : JSON.stringify({ command: item.command }),
    })
    row.outputText = execOutput(item)
    b.hint(name, item.input ?? { command: item.command ?? undefined }, row.messageId, row.id)
  }

  return b.finish({
    nativeSessionId: options.nativeSessionId,
    workspaceRoot: options.workspaceRoot,
    sourcePath: options.sourcePath,
    title: options.title,
    diagnostics: options.diagnostics,
  })
}
