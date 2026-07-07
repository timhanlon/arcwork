import { Config, Context, Effect, Layer } from "effect"
import {
  chooseModel,
  loadLmStudioConfig,
  lmStudioTimeoutConfig,
  withTimeout,
  type LmStudioConfig,
} from "./lmstudio.js"

export type LocalModelStatus =
  | {
      readonly enabled: true
      readonly provider: "lmstudio"
      readonly baseUrl: string
      readonly model: string | null
      readonly reachable: boolean
      readonly message: string
    }
  | {
      readonly enabled: false
      readonly provider: "lmstudio"
      readonly baseUrl: string
      readonly model: string | null
      readonly reachable: false
      readonly message: string
    }

export class LocalModelService extends Context.Service<
  LocalModelService,
  {
    readonly status: Effect.Effect<LocalModelStatus>
    readonly generateChatTitle: (input: {
      readonly firstUserPrompt: string
    }) => Effect.Effect<string | null>
  }
>()("LocalModelService") {}

const DEFAULT_TIMEOUT_MS = 10000
const MAX_PROMPT_CHARS = 4000

// The shared endpoint config plus this feature's own (short) completion timeout.
interface TitleConfig extends LmStudioConfig {
  readonly timeoutMs: number
}

const loadConfig: Config.Config<TitleConfig> = Config.all({
  base: loadLmStudioConfig,
  timeoutMs: lmStudioTimeoutConfig("ARC_LMSTUDIO_TIMEOUT_MS", DEFAULT_TIMEOUT_MS),
}).pipe(Config.map(({ base, timeoutMs }) => ({ ...base, timeoutMs })))

const jsonRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

const extractTitle = (payload: unknown): string | null => {
  const choices = jsonRecord(payload)?.["choices"]
  if (!Array.isArray(choices)) return null
  const first = jsonRecord(choices[0])
  const message = jsonRecord(first?.["message"])
  const content = message?.["content"]
  if (typeof content !== "string") return null
  const title = content
    .replace(/^["'\s]+|["'\s]+$/g, "")
    .replace(/\s+/g, " ")
    .trim()
  if (title.length < 3) return null
  return title.length > 80 ? `${title.slice(0, 77).trimEnd()}...` : title
}

export const LocalModelServiceLive = Layer.effect(
  LocalModelService,
  Effect.gen(function* () {
    const cfg = yield* loadConfig
    return LocalModelService.of({
      status: Effect.promise(async () => {
        try {
          if (!cfg.enabled) {
            return {
              enabled: false,
              provider: "lmstudio",
              baseUrl: cfg.baseUrl,
              model: cfg.model,
              reachable: false,
              message: "LM Studio local model support is disabled",
            } as const
          }

          const response = await withTimeout(cfg.timeoutMs, (signal) =>
            fetch(`${cfg.baseUrl}/models`, { signal }),
          )
          if (!response.ok) {
            return {
              enabled: true,
              provider: "lmstudio",
              baseUrl: cfg.baseUrl,
              model: cfg.model,
              reachable: false,
              message: `LM Studio returned HTTP ${response.status}`,
            } as const
          }
          const payload = await response.json() as unknown
          const selected = chooseModel(cfg.model, payload)
          return {
            enabled: true,
            provider: "lmstudio",
            baseUrl: cfg.baseUrl,
            model: selected,
            reachable: Boolean(selected),
            message: selected ? "LM Studio is reachable" : "LM Studio has no loaded model",
          } as const
        } catch (error) {
          return {
            enabled: cfg.enabled,
            provider: "lmstudio",
            baseUrl: cfg.baseUrl,
            model: cfg.model,
            reachable: false,
            message: error instanceof Error ? error.message : String(error),
          } as LocalModelStatus
        }
      }),

      generateChatTitle: ({ firstUserPrompt }) =>
        Effect.promise(async () => {
          try {
            if (!cfg.enabled) return null
            const modelsResponse = await withTimeout(cfg.timeoutMs, (signal) =>
              fetch(`${cfg.baseUrl}/models`, { signal }),
            )
            if (!modelsResponse.ok) return null
            const model = chooseModel(cfg.model, await modelsResponse.json() as unknown)
            if (!model) return null

            const prompt = firstUserPrompt.trim().slice(0, MAX_PROMPT_CHARS)
            const completion = await withTimeout(cfg.timeoutMs, (signal) =>
              fetch(`${cfg.baseUrl}/chat/completions`, {
                method: "POST",
                headers: { "content-type": "application/json" },
                signal,
                body: JSON.stringify({
                  model,
                  messages: [
                    {
                      role: "system",
                      content:
                        "Generate a concise, specific title for this chat. Return only the title, no quotes or punctuation.",
                    },
                    { role: "user", content: prompt },
                  ],
                  temperature: 0.2,
                  max_tokens: 20,
                }),
              }),
            )
            if (!completion.ok) return null
            return extractTitle(await completion.json() as unknown)
          } catch {
            return null
          }
        }),
    })
  }),
)
