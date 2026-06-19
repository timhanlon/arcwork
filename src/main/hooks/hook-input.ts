import type { HookSignal } from "./signals.js"

export const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v)

export const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

export const num = (v: unknown): number | null => {
  if (typeof v === "number" && Number.isFinite(v)) return v
  if (typeof v === "string" && v.length > 0) {
    const n = Number(v)
    return Number.isFinite(n) ? n : null
  }
  return null
}

export const hookInputObj = (signal: HookSignal): Record<string, unknown> | null =>
  isRecord(signal.hookInput) ? signal.hookInput : null
