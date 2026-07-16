import { isHighlighterLoaded, preloadHighlighter } from "@pierre/diffs"
import { useEffect, useState } from "react"

/** The one Shiki theme this app renders diffs with; preload and render must
 * agree on it, so both sides import this constant. */
export const DIFF_THEME = "vitesse-dark"

/**
 * `@pierre/diffs` renders through a lazily-created shared Shiki highlighter,
 * and (as of 1.2.7) a diff that mounts before that instance finishes loading
 * hits a dead path: `DiffHunksRenderer.hydrate` kicks off the load without a
 * completion callback, so nothing ever re-renders and the diff stays blank
 * forever. Gate mounting on readiness instead — preload the theme once, mount
 * `FileDiff`/`PatchDiff` only after the instance exists. From there the
 * library's own async paths (e.g. a grammar loading on demand) do re-render
 * correctly.
 */
export function useDiffHighlighterReady(): boolean {
  const [ready, setReady] = useState(isHighlighterLoaded)
  useEffect(() => {
    if (ready) return
    let cancelled = false
    void preloadHighlighter({ themes: [DIFF_THEME], langs: [] }).then(() => {
      if (!cancelled) setReady(true)
    })
    return () => {
      cancelled = true
    }
  }, [ready])
  return ready
}
