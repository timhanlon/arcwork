import { createRequire } from "node:module"
import type { Dialog, IpcMain, WebContents } from "electron"

/**
 * Electron main-process APIs, loaded so they're *optional*.
 *
 * Under `ELECTRON_RUN_AS_NODE` (the headless test harness) there is no Electron
 * main process: `require("electron")` returns the binary path string, not the
 * module, and a static `import … from "electron"` even crashes the ESM↔CJS
 * preparse before any code runs. Loading via `createRequire` keeps `electron` out
 * of the static link graph, and exposing each API as possibly-`undefined` lets the
 * handful of main-only call sites guard on its presence instead of every module
 * re-implementing this dance. In a real Electron main process these are the live
 * singletons.
 */
/** The static side of the `webContents` module export — just the accessor we use
 * (a value import of the `WebContents` class to write `typeof WebContents` would
 * re-introduce the static `electron` import this module exists to avoid). */
interface WebContentsModule {
  fromId(id: number): WebContents | undefined
}

const electron: unknown = createRequire(import.meta.url)("electron")
const api =
  typeof electron === "object" && electron !== null
    ? (electron as Partial<{ ipcMain: IpcMain; webContents: WebContentsModule; dialog: Dialog }>)
    : {}

export const ipcMain: IpcMain | undefined = api.ipcMain
export const webContents: WebContentsModule | undefined = api.webContents
export const dialog: Dialog | undefined = api.dialog
