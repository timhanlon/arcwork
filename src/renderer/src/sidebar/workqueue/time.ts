/**
 * Compact relative-time label ("4m ago", "2h ago", "1d ago").
 *
 * Takes an explicit `nowMs` reference rather than reading the clock so the
 * prototype's labels stay deterministic against the fixed anchor in
 * `fixtures.ts` — the queue looks the same every time you open Ladle.
 */
export function formatRelative(iso: string, nowMs: number): string {
  const deltaMs = nowMs - new Date(iso).getTime()
  const sec = Math.max(0, Math.round(deltaMs / 1000))
  if (sec < 60) return "just now"
  const min = Math.round(sec / 60)
  if (min < 60) return `${min}m ago`
  const hr = Math.round(min / 60)
  if (hr < 24) return `${hr}h ago`
  const day = Math.round(hr / 24)
  return `${day}d ago`
}
