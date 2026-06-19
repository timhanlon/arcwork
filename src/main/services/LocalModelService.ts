import { Context, Effect, Layer } from "effect"

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

const DEFAULT_BASE_URL = "http://localhost:1234/v1"
const DEFAULT_TIMEOUT_MS = 10000
const MAX_PROMPT_CHARS = 4000

const enabled = (): boolean =>
  ["1", "true", "yes", "on"].includes((process.env.ARC_LMSTUDIO_ENABLED ?? "").toLowerCase())

const baseUrl = (): string => (process.env.ARC_LMSTUDIO_BASE_URL ?? DEFAULT_BASE_URL).replace(/\/+$/, "")
const configuredModel = (): string | null => {
  const model = process.env.ARC_LMSTUDIO_MODEL?.trim()
  return model && model.length > 0 ? model : null
}
const timeoutMs = (): number => {
  const parsed = Number(process.env.ARC_LMSTUDIO_TIMEOUT_MS)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS
}

const withTimeout = async <A>(ms: number, f: (signal: AbortSignal) => Promise<A>): Promise<A> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await f(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

const jsonRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null

const firstModelId = (payload: unknown): string | null => {
  const data = jsonRecord(payload)?.["data"]
  if (!Array.isArray(data)) return null
  for (const item of data) {
    const id = jsonRecord(item)?.["id"]
    if (typeof id === "string" && id.trim().length > 0) return id
  }
  return null
}

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

const chooseModel = (payload: unknown): string | null => configuredModel() ?? firstModelId(payload)

export const LocalModelServiceLive = Layer.succeed(
  LocalModelService,
  LocalModelService.of({
    status: Effect.promise(async () => {
      try {
        const url = baseUrl()
        const model = configuredModel()
        if (!enabled()) {
          return {
            enabled: false,
            provider: "lmstudio",
            baseUrl: url,
            model,
            reachable: false,
            message: "LM Studio local model support is disabled",
          } as const
        }

        const response = await withTimeout(timeoutMs(), (signal) =>
          fetch(`${url}/models`, { signal }),
        )
        if (!response.ok) {
          return {
            enabled: true,
            provider: "lmstudio",
            baseUrl: url,
            model,
            reachable: false,
            message: `LM Studio returned HTTP ${response.status}`,
          } as const
        }
        const payload = await response.json() as unknown
        const selected = chooseModel(payload)
        return {
          enabled: true,
          provider: "lmstudio",
          baseUrl: url,
          model: selected,
          reachable: Boolean(selected),
          message: selected ? "LM Studio is reachable" : "LM Studio has no loaded model",
        } as const
      } catch (error) {
        return {
        enabled: enabled(),
        provider: "lmstudio",
        baseUrl: baseUrl(),
        model: configuredModel(),
        reachable: false,
        message: error instanceof Error ? error.message : String(error),
        } as LocalModelStatus
      }
    }),

    generateChatTitle: ({ firstUserPrompt }) =>
      Effect.promise(async () => {
        try {
          if (!enabled()) return null
          const url = baseUrl()
          const modelsResponse = await withTimeout(timeoutMs(), (signal) =>
            fetch(`${url}/models`, { signal }),
          )
          if (!modelsResponse.ok) return null
          const model = chooseModel(await modelsResponse.json() as unknown)
          if (!model) return null

          const prompt = firstUserPrompt.trim().slice(0, MAX_PROMPT_CHARS)
          const completion = await withTimeout(timeoutMs(), (signal) =>
            fetch(`${url}/chat/completions`, {
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
  }),
)
