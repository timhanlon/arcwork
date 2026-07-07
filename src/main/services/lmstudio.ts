import { Config } from "effect"

/**
 * Shared LM Studio (OpenAI-compatible) plumbing for the local-model features:
 * the title generator ({@link LocalModelService}) and the chat-summary distiller
 * both talk to the same server, so config loading and the model-pick helpers
 * live here rather than being copied per feature.
 *
 * Config degrades to safe defaults (a typo in `ARC_LMSTUDIO_*` must never crash
 * startup), and each feature loads its own timeout Config on top — a title
 * completion is a few tokens and wants a short deadline, a distillation is
 * thousands of tokens and needs minutes.
 */

export const LMSTUDIO_DEFAULT_BASE_URL = "http://localhost:1234/v1"

/** The shared endpoint config, minus any per-feature timeout. */
export interface LmStudioConfig {
  readonly enabled: boolean
  readonly baseUrl: string
  readonly model: string | null
}

// A missing OR malformed env var degrades to the default (orElse) rather than
// failing layer construction. Read once when the layer builds; the values are
// process env, which doesn't change at runtime.
export const loadLmStudioConfig: Config.Config<LmStudioConfig> = Config.all({
  enabled: Config.boolean("ARC_LMSTUDIO_ENABLED").pipe(Config.orElse(() => Config.succeed(false))),
  baseUrl: Config.string("ARC_LMSTUDIO_BASE_URL").pipe(Config.withDefault(LMSTUDIO_DEFAULT_BASE_URL)),
  model: Config.string("ARC_LMSTUDIO_MODEL").pipe(Config.withDefault("")),
}).pipe(
  Config.map((raw): LmStudioConfig => {
    const model = raw.model.trim()
    return {
      enabled: raw.enabled,
      baseUrl: raw.baseUrl.replace(/\/+$/, ""),
      model: model.length > 0 ? model : null,
    }
  }),
)

/** A per-feature timeout Config: reads `envName`, falling back to `fallbackMs`
 * for a missing, malformed, or non-positive value. */
export const lmStudioTimeoutConfig = (envName: string, fallbackMs: number): Config.Config<number> =>
  Config.int(envName).pipe(
    Config.orElse(() => Config.succeed(fallbackMs)),
    Config.map((ms) => (ms > 0 ? ms : fallbackMs)),
  )

/** Run `f` with an abort signal that fires after `ms`, always clearing the timer. */
export const withTimeout = async <A>(ms: number, f: (signal: AbortSignal) => Promise<A>): Promise<A> => {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), ms)
  try {
    return await f(controller.signal)
  } finally {
    clearTimeout(timer)
  }
}

export const jsonRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null

/** First non-empty `id` in an OpenAI `/models` list payload, or null. */
export const firstModelId = (payload: unknown): string | null => {
  const data = jsonRecord(payload)?.["data"]
  if (!Array.isArray(data)) return null
  for (const item of data) {
    const id = jsonRecord(item)?.["id"]
    if (typeof id === "string" && id.trim().length > 0) return id
  }
  return null
}

/** The configured model when set, else the first model the server advertises. */
export const chooseModel = (configuredModel: string | null, payload: unknown): string | null =>
  configuredModel ?? firstModelId(payload)
