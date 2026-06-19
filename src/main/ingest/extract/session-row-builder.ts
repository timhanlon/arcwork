import type {
  DiagnosticRow,
  ExtractedRows,
  FileHintRow,
  MessageRow,
  Mutable,
  Provider,
  ToolCallRow,
} from "../db/schema.js"
import { hintsFromToolInput } from "./file-hints.js"
import * as ids from "./ids.js"

type Rec = Record<string, unknown>

/**
 * The mechanical half of every provider normalizer, behind one small interface.
 *
 * Each provider walks a different source shape (Claude's DAG-flattened records,
 * Cursor's ordered blobs, Codex's chronological event stream) and applies its
 * own quirks and tool-result coercion — that stays in the provider. What every
 * provider repeated identically lives here: the row arrays, the per-table
 * sequence counters, the deterministic id scheme, tool→result pairing by native
 * call id, file-hint derivation, the first-user-text title seed, and the
 * diagnostics + session assembly in {@link finish}.
 *
 * The load-bearing reason to centralize is the **shared `ordinal` counter**
 * (see {@link MessageRow.ordinal}): one monotonic value stamped across messages
 * *and* tool calls so a transcript view can `ORDER BY ordinal` over
 * `messages UNION tool_calls` and recover the true interleaving. Hand-rolled in
 * three places, a single missed `ord++` on a new row type silently corrupts
 * display order; here `message()` and `tool()` are the only things that advance
 * it, so the invariant holds by construction.
 */
export class SessionRowBuilder {
  /** Deterministic session id (`provider:nativeSessionId`); also the row-id prefix. */
  readonly sid: string

  /** Earliest observed timestamp; the session `created_at` unless `finish` overrides. */
  createdAt?: string
  /** Latest observed timestamp; the session `updated_at` unless `finish` overrides. */
  updatedAt?: string

  private readonly provider: Provider
  private readonly messages: Array<MessageRow> = []
  private readonly toolCalls: Array<Mutable<ToolCallRow>> = []
  private readonly fileHints: Array<FileHintRow> = []
  private readonly toolByCallId = new Map<string, Mutable<ToolCallRow>>()

  private msgSeq = 0
  private toolSeq = 0
  private hintSeq = 0
  // Shared display counter across messages + tool calls (see MessageRow.ordinal).
  private ord = 0
  private firstUserText?: string

  constructor(provider: Provider, nativeSessionId: string) {
    this.provider = provider
    this.sid = ids.sessionId(provider, nativeSessionId)
  }

  /** Fold a record timestamp into `created_at` (first seen) and `updated_at` (last seen). */
  observeTimestamp(timestamp: string | null | undefined): void {
    if (!timestamp) return
    this.createdAt ??= timestamp
    this.updatedAt = timestamp
  }

  /** Append a renderable message row in source order; returns its id for tool attachment. */
  message(opts: {
    readonly role: string
    readonly text?: string | null
    readonly thinking?: string | null
    readonly model?: string | null
    readonly createdAt?: string | null
    readonly nativeMessageId?: string | null
  }): string {
    const id = ids.messageId(this.sid, this.msgSeq)
    this.messages.push({
      id,
      sessionId: this.sid,
      provider: this.provider,
      nativeMessageId: opts.nativeMessageId ?? null,
      role: opts.role,
      createdAt: opts.createdAt ?? null,
      model: opts.model ?? null,
      text: opts.text ?? null,
      thinking: opts.thinking ?? null,
      rawJson: null,
      sequence: this.msgSeq,
      ordinal: this.ord++,
    })
    this.msgSeq++
    // First real user prompt seeds the session title (see finish).
    if (opts.role === "user" && opts.text) this.firstUserText ??= opts.text
    return id
  }

  /**
   * Append a tool-call row in source order and, when it carries a native call
   * id, register it so a later {@link result} can attach its output. Returns the
   * mutable row so the provider can fill provider-specific fields (e.g. Claude's
   * AskUserQuestion `rawJson` sidecar).
   */
  tool(opts: {
    readonly name?: string | null
    readonly kind?: string | null
    readonly nativeToolId?: string | null
    readonly messageId?: string | null
    readonly inputJson?: string | null
  }): Mutable<ToolCallRow> {
    const id = ids.toolCallId(this.sid, this.toolSeq)
    const row: Mutable<ToolCallRow> = {
      id,
      sessionId: this.sid,
      messageId: opts.messageId ?? null,
      provider: this.provider,
      nativeToolId: opts.nativeToolId ?? null,
      name: opts.name ?? null,
      kind: opts.kind ?? null,
      inputJson: opts.inputJson ?? null,
      outputText: null,
      rawJson: null,
      sequence: this.toolSeq,
      ordinal: this.ord++,
    }
    this.toolCalls.push(row)
    this.toolSeq++
    if (opts.nativeToolId) this.toolByCallId.set(opts.nativeToolId, row)
    return row
  }

  /**
   * Attach a (provider-coerced) result to a previously-recorded tool call,
   * matched by native call id. Returns the row when found so the provider can
   * make further edits; returns undefined for an unknown or absent id.
   */
  result(callId: string | null | undefined, outputText?: string): Mutable<ToolCallRow> | undefined {
    if (!callId) return undefined
    const row = this.toolByCallId.get(callId)
    if (!row) return undefined
    if (outputText !== undefined) row.outputText = outputText
    return row
  }

  /** Derive and append best-effort file-path hints from a decoded tool input. */
  hint(
    name: string | undefined,
    input: Rec | undefined,
    messageId: string | null,
    toolCallId: string,
  ): void {
    for (const h of hintsFromToolInput(name, input)) {
      this.fileHints.push({
        id: ids.fileHintId(this.sid, this.hintSeq++),
        sessionId: this.sid,
        messageId,
        toolCallId,
        provider: this.provider,
        path: h.path,
        source: h.source,
        confidence: h.confidence,
        rawJson: null,
      })
    }
  }

  /** Assemble the session row + diagnostics and return the full extracted rows. */
  finish(meta: {
    readonly nativeSessionId: string
    readonly workspaceRoot: string
    readonly sourcePath: string
    readonly title?: string
    readonly createdAt?: string | null
    readonly updatedAt?: string | null
    readonly rawMetadataJson?: string | null
    readonly diagnostics?: ReadonlyArray<
      Pick<DiagnosticRow, "severity" | "code" | "message" | "sourcePath">
    >
  }): ExtractedRows {
    const createdAt = meta.createdAt ?? this.createdAt ?? null
    const updatedAt = meta.updatedAt ?? this.updatedAt ?? null

    const diagnostics: Array<DiagnosticRow> = []
    let diagSeq = 0
    for (const d of meta.diagnostics ?? []) {
      diagnostics.push({
        id: ids.diagnosticId(this.sid, diagSeq++),
        sessionId: this.sid,
        provider: this.provider,
        severity: d.severity,
        code: d.code,
        message: d.message,
        sourcePath: d.sourcePath,
        rawJson: null,
        createdAt: createdAt ?? new Date(0).toISOString(),
      })
    }

    const title =
      meta.title ?? (this.firstUserText ? this.firstUserText.split("\n")[0]!.slice(0, 120) : null)

    return {
      session: {
        id: this.sid,
        provider: this.provider,
        nativeSessionId: meta.nativeSessionId,
        workspaceRoot: meta.workspaceRoot,
        title,
        createdAt,
        updatedAt,
        sourcePath: meta.sourcePath,
        rawMetadataJson: meta.rawMetadataJson ?? null,
      },
      messages: this.messages,
      toolCalls: this.toolCalls,
      fileHints: this.fileHints,
      diagnostics,
    }
  }
}
