import { Clock, Config, Context, Effect, Layer, Schema } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { createHash } from "node:crypto"
import { ArcStore } from "../db/store.js"
import { WorkStore } from "../work/store.js"
import type { SummaryNodeRow } from "../work/schema.js"
import { nowIso } from "../clock.js"
import { newArcId, type ChatId } from "../../shared/ids.js"
import type { ChatSummary } from "../../shared/chat-summary.js"
import {
  chooseModel,
  loadLmStudioConfig,
  lmStudioTimeoutConfig,
  withTimeout,
} from "../services/lmstudio.js"
import { renderTimeline } from "./render-timeline.js"
import { buildDistillPrompt, PROMPT_VERSION } from "./prompt.js"

/**
 * Distill a chat's message timeline into a structured summary using a local
 * LM Studio (OpenAI-compatible) model, and persist it as a `summary` graph node.
 *
 * Separate from {@link LocalModelService} on purpose: that service stays
 * title-shaped (a few tokens, a short deadline, a nullable best-effort return).
 * Distillation is thousands of tokens over minutes and its failures are
 * user-facing, so it carries typed tagged errors and a much longer timeout —
 * only the endpoint config + model-pick helpers are shared (see `lmstudio.ts`).
 */

// A chat longer than this has its per-role caps tightened proportionally by the
// renderer rather than the head/tail being dropped — so an enormous session still
// distills, just more coarsely.
const DISTILL_CHAR_BUDGET = 200_000

const DEFAULT_PROBE_TIMEOUT_MS = 10_000
const DEFAULT_DISTILL_TIMEOUT_MS = 300_000

// ── Typed errors (causes carried as Schema.Defect for clean Cause rendering) ──

/** LM Studio support is switched off (`ARC_LMSTUDIO_ENABLED` is not set). */
export class LocalModelDisabled extends Schema.TaggedErrorClass<LocalModelDisabled>()(
  "arc/summary/LocalModelDisabled",
  {},
) {
  get message(): string {
    return "LM Studio local model support is disabled"
  }
}

/** The `/models` probe could not reach LM Studio (network error / timeout). */
export class LocalModelUnreachable extends Schema.TaggedErrorClass<LocalModelUnreachable>()(
  "arc/summary/LocalModelUnreachable",
  { cause: Schema.Defect },
) {
  get message(): string {
    return "LM Studio is unreachable"
  }
}

/** LM Studio is reachable but has no model loaded and none is configured. */
export class NoModelAvailable extends Schema.TaggedErrorClass<NoModelAvailable>()(
  "arc/summary/NoModelAvailable",
  {},
) {
  get message(): string {
    return "LM Studio has no loaded model"
  }
}

/** A non-2xx HTTP response from `/models` or `/chat/completions`. */
export class DistillHttpError extends Schema.TaggedErrorClass<DistillHttpError>()(
  "arc/summary/DistillHttpError",
  { status: Schema.Number, body: Schema.String },
) {
  get message(): string {
    return `LM Studio returned HTTP ${this.status}`
  }
}

/** The `/chat/completions` request threw (network error / timeout mid-turn). */
export class DistillTransportError extends Schema.TaggedErrorClass<DistillTransportError>()(
  "arc/summary/DistillTransportError",
  { cause: Schema.Defect },
) {
  get message(): string {
    return "LM Studio distillation request failed"
  }
}

/** The completion response did not decode, or carried no assistant content. */
export class MalformedResponse extends Schema.TaggedErrorClass<MalformedResponse>()(
  "arc/summary/MalformedResponse",
  { detail: Schema.String },
) {
  get message(): string {
    return `LM Studio returned a malformed response: ${this.detail}`
  }
}

/** The chat rendered to an empty timeline — nothing to summarize. */
export class EmptyChat extends Schema.TaggedErrorClass<EmptyChat>()(
  "arc/summary/EmptyChat",
  { chatId: Schema.String },
) {
  get message(): string {
    return `Chat ${this.chatId} has no timeline to summarize`
  }
}

export type ChatSummaryError =
  | LocalModelDisabled
  | LocalModelUnreachable
  | NoModelAvailable
  | DistillHttpError
  | DistillTransportError
  | MalformedResponse
  | EmptyChat

// ── Chat-completions response schema (decoded, never cast) ────────────────────

const ChatCompletionResponse = Schema.Struct({
  choices: Schema.Array(
    Schema.Struct({
      message: Schema.Struct({ content: Schema.optional(Schema.NullOr(Schema.String)) }),
    }),
  ),
  usage: Schema.optional(
    Schema.Struct({
      prompt_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
      completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
    }),
  ),
})
const decodeCompletion = Schema.decodeUnknownEffect(Schema.fromJsonString(ChatCompletionResponse))

const sha256 = (s: string): string => createHash("sha256").update(s).digest("hex")

const toChatSummary = (row: SummaryNodeRow): ChatSummary => ({
  _tag: "ChatSummary",
  id: row.id,
  chatId: row.chatId,
  body: row.body,
  model: row.model,
  promptVersion: row.promptVersion,
  inputHash: row.inputHash,
  usage: { promptTokens: row.promptTokens, completionTokens: row.completionTokens },
  durationMs: row.durationMs,
  createdAt: row.createdAt,
})

export class ChatSummaryDistiller extends Context.Service<
  ChatSummaryDistiller,
  {
    /** Render → prompt → LM Studio → persist. Returns the existing summary when a
     * re-distill's (chat, model, promptVersion, inputHash) key already exists. */
    readonly distill: (chatId: ChatId) => Effect.Effect<ChatSummary, ChatSummaryError | SqlError>
    /** The chat's most recently persisted summary, or null. */
    readonly latest: (chatId: ChatId) => Effect.Effect<ChatSummary | null, SqlError>
  }
>()("arcwork/ChatSummaryDistiller") {}

const loadConfig = Config.all({
  base: loadLmStudioConfig,
  probeTimeoutMs: lmStudioTimeoutConfig("ARC_LMSTUDIO_TIMEOUT_MS", DEFAULT_PROBE_TIMEOUT_MS),
  distillTimeoutMs: lmStudioTimeoutConfig("ARC_LMSTUDIO_DISTILL_TIMEOUT_MS", DEFAULT_DISTILL_TIMEOUT_MS),
}).pipe(Config.map(({ base, probeTimeoutMs, distillTimeoutMs }) => ({ ...base, probeTimeoutMs, distillTimeoutMs })))

export const ChatSummaryDistillerLive = Layer.effect(
  ChatSummaryDistiller,
  Effect.gen(function* () {
    const cfg = yield* loadConfig
    const arc = yield* ArcStore
    const work = yield* WorkStore

    // Bounded body read for error reporting — never fails the surrounding flow.
    const readBodySafe = (res: Response) =>
      Effect.tryPromise({ try: () => res.text(), catch: () => new Error("body read failed") }).pipe(
        Effect.map((t) => t.slice(0, 500)),
        Effect.orElseSucceed(() => ""),
      )

    // Resolve the model to distill with: probe `/models`, honoring a configured
    // override, else the first advertised model.
    const pickModel = Effect.gen(function* () {
      const res = yield* Effect.tryPromise({
        try: () => withTimeout(cfg.probeTimeoutMs, (signal) => fetch(`${cfg.baseUrl}/models`, { signal })),
        catch: (cause) => new LocalModelUnreachable({ cause }),
      })
      if (!res.ok) {
        const body = yield* readBodySafe(res)
        return yield* new DistillHttpError({ status: res.status, body })
      }
      const payload = yield* Effect.tryPromise({
        try: () => res.json() as Promise<unknown>,
        catch: (cause) => new LocalModelUnreachable({ cause }),
      })
      const model = chooseModel(cfg.model, payload)
      if (!model) return yield* new NoModelAvailable({})
      return model
    })

    const postCompletion = (model: string, prompt: string) =>
      Effect.gen(function* () {
        const res = yield* Effect.tryPromise({
          try: () =>
            withTimeout(cfg.distillTimeoutMs, (signal) =>
              fetch(`${cfg.baseUrl}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal,
                body: JSON.stringify({
                  model,
                  messages: [{ role: "user", content: prompt }],
                  temperature: 0.2,
                  max_tokens: 6000,
                }),
              }),
            ),
          catch: (cause) => new DistillTransportError({ cause }),
        })
        if (!res.ok) {
          const body = yield* readBodySafe(res)
          return yield* new DistillHttpError({ status: res.status, body })
        }
        return yield* Effect.tryPromise({
          try: () => res.text(),
          catch: (cause) => new DistillTransportError({ cause }),
        })
      })

    const distill = Effect.fn("ChatSummaryDistiller.distill")((chatId: ChatId) =>
      Effect.gen(function* () {
        if (!cfg.enabled) return yield* new LocalModelDisabled({})

        const model = yield* pickModel

        const rows = yield* arc.loadChatMessagesForChat(chatId)
        const timeline = renderTimeline(rows, { charBudget: DISTILL_CHAR_BUDGET })
        if (timeline.trim().length === 0) return yield* new EmptyChat({ chatId })

        const inputHash = sha256(timeline)
        const key = { chatId, model, promptVersion: PROMPT_VERSION, inputHash }

        // Idempotency: an identical key already distilled returns that summary,
        // so a repeat trigger costs a lookup, not a fresh (minutes-long) call.
        const existing = yield* work.loadSummaryByKey(key)
        if (existing) return toChatSummary(existing)

        const prompt = buildDistillPrompt(timeline)
        const startedAt = yield* Clock.currentTimeMillis
        const bodyText = yield* postCompletion(model, prompt)
        const durationMs = (yield* Clock.currentTimeMillis) - startedAt

        const parsed = yield* decodeCompletion(bodyText).pipe(
          Effect.mapError(
            () => new MalformedResponse({ detail: "response did not match the chat-completions shape" }),
          ),
        )
        const content = parsed.choices[0]?.message.content
        if (typeof content !== "string" || content.trim().length === 0) {
          return yield* new MalformedResponse({ detail: "no assistant content" })
        }

        const workspaceId = yield* arc.workspaceIdForChat(chatId)
        const now = yield* nowIso
        const row: SummaryNodeRow = {
          id: newArcId("summary"),
          chatId,
          workspaceId,
          body: content.trim(),
          model,
          promptVersion: PROMPT_VERSION,
          inputHash,
          promptTokens: parsed.usage?.prompt_tokens ?? null,
          completionTokens: parsed.usage?.completion_tokens ?? null,
          durationMs,
          createdAt: now,
        }
        const persisted = yield* work.insertSummary(row)
        if (persisted) return toChatSummary(row)

        // A concurrent distill of the same inputs won the idempotency race while
        // this one was calling the model. The winner exists by construction — the
        // insert conflict proves an identical-key row is present — so an
        // unreadable lookup here is an invariant violation, not our un-persisted
        // row to hand back under a ghost id.
        const winner = yield* work.loadSummaryByKey(key)
        if (!winner) {
          return yield* Effect.die(
            new Error(`chat-summary idempotency race lost but no persisted row found for ${chatId}`),
          )
        }
        return toChatSummary(winner)
      }),
    )

    const latest = (chatId: ChatId) =>
      Effect.map(work.loadLatestSummaryForChat(chatId), (row) => (row ? toChatSummary(row) : null))

    return ChatSummaryDistiller.of({ distill, latest })
  }),
)
