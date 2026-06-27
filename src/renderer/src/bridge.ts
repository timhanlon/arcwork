/**
 * The preload bridge gate.
 *
 * `window.arc` (the `contextBridge` surface) is exposed before paint but *after*
 * the renderer's modules first evaluate — on this app, ~tens of ms later, while
 * the preload loads. Any renderer code that touches `window.arc` at mount/module
 * time therefore races that attach and can throw `Cannot read … of undefined`.
 * Every access should go through {@link waitForBridge} (or read it lazily well
 * after mount). This module owns that gate and a bridge-independent dev logger.
 */

type ViteImportMeta = ImportMeta & { readonly env?: { readonly DEV?: boolean } }

/** Build-time dev flag from Vite — independent of `window.arc`, so it works even when the bridge is the thing that's missing. */
export const DEV = ((import.meta as ViteImportMeta).env?.DEV ?? false) === true

/** Runtime *profile* flag — the launched profile (dev vs stable), read off the
 * bridge rather than the build env. Distinct from {@link DEV}: a packaged build
 * can still run the dev profile. Lazy (not a module const) so it reads `profile`
 * after the bridge has attached, not at module-eval time when `window.arc` may
 * still be undefined. */
export const isDevProfile = (): boolean => window.arc?.profile === "dev"

/** A dev-only, `[scope]`-prefixed console logger (Default level, so it shows without enabling Verbose). */
export const devLog =
  (scope: string) =>
  (event: string, detail?: Record<string, unknown>): void => {
    if (!DEV) return
    // eslint-disable-next-line no-console
    if (detail) console.info(`${scope} ${event}`, detail)
    // eslint-disable-next-line no-console
    else console.info(`${scope} ${event}`)
  }

const log = devLog("[arc/bridge]")

let bridgePromise: Promise<Window["arc"]> | undefined

/**
 * Resolve once the preload has attached `window.arc`. Memoized, so every caller
 * shares one wait; a genuinely broken preload rejects after a bounded timeout
 * rather than hanging forever.
 */
export const waitForBridge = (): Promise<Window["arc"]> =>
  (bridgePromise ??= new Promise<Window["arc"]>((resolve, reject) => {
    if (window.arc) return resolve(window.arc)
    log("not ready; waiting for preload to attach window.arc")
    const startedAt = Date.now()
    const tick = (): void => {
      if (window.arc) {
        log("ready", { waitedMs: Date.now() - startedAt })
        resolve(window.arc)
      } else if (Date.now() - startedAt > 5000) {
        reject(new Error("[arc/bridge] preload bridge (window.arc) never attached after 5s"))
      } else {
        setTimeout(tick, 25)
      }
    }
    tick()
  }))

/**
 * Subscribe to a push channel as soon as the bridge is ready, returning an
 * unsubscribe that works whether or not the wait has resolved yet. For use in
 * React effects: `useEffect(() => subscribeWhenReady((arc) => arc.onAssistantStream(cb)), [])`.
 */
export const subscribeWhenReady = (
  subscribe: (arc: Window["arc"]) => () => void,
): (() => void) => {
  let unsub: (() => void) | undefined
  let cancelled = false
  void waitForBridge().then((arc) => {
    if (!cancelled) unsub = subscribe(arc)
  })
  return () => {
    cancelled = true
    unsub?.()
  }
}
