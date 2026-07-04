import { Option } from "effect"
import type { DiagnosticRow, ExtractedRows } from "../../db/schema.js"
import { obj, str } from "../../extract/json.js"
import { SessionRowBuilder } from "../../extract/session-row-builder.js"
import { classifyTool } from "../../extract/tool-kind.js"
import { type AppServerItem, decodeItem, decodeUsage } from "./protocol.js"

export interface AppServerNormalizeOptions {
  /** The app-server thread id — the native session id for the `codex` provider. */
  readonly nativeSessionId: string
  readonly workspaceRoot: string
  /** A stable handle for this live thread (e.g. `appserver:<threadId>`). */
  readonly sourcePath: string
  readonly model?: string | null
  readonly title?: string
  readonly createdAt?: string | null
  readonly updatedAt?: string | null
  readonly diagnostics?: ReadonlyArray<Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">>
}

const finite = (value: number | undefined): number | null =>
  value === undefined || !Number.isFinite(value) ? null : value

/** A completed exec's output, prefixed `[exit N]` on failure (mirrors codex.ts). */
const execOutput = (item: Extract<AppServerItem, { type: "commandExecution" }>): string => {
  const body = item.aggregatedOutput ?? ""
  return item.exitCode != null && item.exitCode !== 0 ? `[exit ${item.exitCode}]\n${body}` : body
}

/** Join reasoning summary/content parts (string parts or `{ text }` parts). */
const reasoningText = (item: Extract<AppServerItem, { type: "reasoning" }>): string | null => {
  const parts = [...(item.summary ?? []), ...(item.content ?? [])]
  const texts: Array<string> = []
  for (const part of parts) {
    const text = typeof part === "string" ? part : str(obj(part)?.["text"])
    if (text) texts.push(text)
  }
  const joined = texts.join("\n\n").trim()
  return joined.length > 0 ? joined : null
}

/**
 * Fold a codex app-server thread's `item/completed` payloads (plus its
 * `thread/tokenUsage/updated` snapshots) into database-shaped rows — the same
 * `ExtractedRows` the rollout-file provider produces, via the same
 * {@link SessionRowBuilder}. This is the live-transport counterpart to
 * `normalizeCodexRecords`: the switch mirrors that provider's `switch (p.type)`,
 * but tool results arrive structured (no `EXEC_WRAPPER` regex) and each exec is
 * one completed item carrying its own command + exit code + output.
 *
 * `rawItems` are the items in `item/completed` order; `rawUsage` the usage
 * notification params in arrival order. Both are decoded here (untrusted wire
 * JSON), and an undecodable entry is skipped, never thrown.
 */
export const normalizeAppServerThread = (
  rawItems: ReadonlyArray<unknown>,
  rawUsage: ReadonlyArray<unknown>,
  options: AppServerNormalizeOptions,
): ExtractedRows => {
  const b = new SessionRowBuilder("codex", options.nativeSessionId)
  const model = options.model ?? null

  for (const raw of rawItems) {
    const decoded = decodeItem(raw)
    if (Option.isNone(decoded)) continue
    const item = decoded.value

    switch (item.type) {
      case "userMessage": {
        const text = (item.content ?? [])
          .filter((c) => c.type === "text")
          .map((c) => c.text ?? "")
          .join("")
          .trim()
        if (text) b.message({ role: "user", text, nativeMessageId: item.id ?? null })
        break
      }
      case "agentMessage": {
        const text = item.text?.trim()
        if (text) b.message({ role: "assistant", text: item.text, model, nativeMessageId: item.id ?? null })
        break
      }
      case "reasoning": {
        const thinking = reasoningText(item)
        if (thinking) b.message({ role: "assistant", thinking, model, nativeMessageId: item.id ?? null })
        break
      }
      case "commandExecution": {
        const row = b.tool({
          name: "shell",
          kind: classifyTool("codex", "shell"),
          nativeToolId: item.id,
          inputJson: JSON.stringify({ command: item.command ?? null, cwd: item.cwd ?? null }),
        })
        row.outputText = execOutput(item)
        b.hint("shell", { command: item.command }, row.messageId, row.id)
        break
      }
    }
  }

  for (const raw of rawUsage) {
    const decoded = decodeUsage(raw)
    if (Option.isNone(decoded)) continue
    const usage = decoded.value.tokenUsage
    const last = usage.last
    const inputTokens = finite(last?.inputTokens)
    b.usage({
      model,
      contextUsedTokens: inputTokens,
      contextWindowTokens: finite(usage.modelContextWindow),
      inputTokens,
      outputTokens: finite(last?.outputTokens),
      rawJson: JSON.stringify(raw),
    })
  }

  return b.finish({
    nativeSessionId: options.nativeSessionId,
    workspaceRoot: options.workspaceRoot,
    sourcePath: options.sourcePath,
    title: options.title,
    createdAt: options.createdAt,
    updatedAt: options.updatedAt,
    diagnostics: options.diagnostics,
  })
}
