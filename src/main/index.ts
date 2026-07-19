import { app, BrowserWindow, ipcMain, shell } from "electron"
import { Effect, Exit, Scope } from "effect"
import { existsSync, readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { parseEnv } from "node:util"
import path from "node:path"
import { runtime } from "./runtime.js"
import { queryLoginShellPath, mergePath } from "./login-path.js"
import { resolveArcDb, APP_NAME, resolveProfile } from "./db/paths.js"
import { launchArcMainController } from "./services/ArcMainController.js"
import type { RendererTransport } from "./services/ArcMainController.js"
import { registerArcImgHandler, registerArcImgScheme } from "./services/imageProtocol.js"
import { OPEN_PATH_CHANNEL } from "../shared/rpc.js"

const dirname = path.dirname(fileURLToPath(import.meta.url))

// Register the `arc-img://` scheme now — scheme privileges must be declared
// before `app.whenReady()`. The request handler is installed after ready.
registerArcImgScheme()

// Load the repo-root `.env` into `process.env`, leaving any variable the parent
// already set untouched (so an explicit `ARC_PROFILE=… pnpm dev` wins).
// `util.parseEnv` is the same parser `node --env-file` uses, so
// quoting/escaping matches Node's own rules.
const loadDotenv = (): void => {
  const envPath = path.join(process.cwd(), ".env")
  if (!existsSync(envPath)) return
  const parsed = parseEnv(readFileSync(envPath, "utf8"))
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined) process.env[key] = value
  }
}

loadDotenv()

/**
 * Repair PATH for a Finder/`open`-launched packaged build. Such a launch inherits
 * launchd's minimal PATH (`/usr/bin:/bin:/usr/sbin:/sbin`), so provider CLIs
 * (`claude`, `codex`, `cursor-agent`, `pi`) installed under `~/.local/bin`,
 * Homebrew, or nvm aren't on PATH and every target PTY spawn fails with
 * `posix_spawnp failed` (ENOENT). A terminal / `pnpm dev` launch already carries
 * the user's full PATH, so this is gated on `app.isPackaged` to skip the
 * login-shell round-trip in development. Must run before any target spawn (well
 * before `app.whenReady`).
 */
function repairLoginPath(): void {
  if (!app.isPackaged) return
  const before = process.env["PATH"] ?? ""
  const merged = mergePath(queryLoginShellPath(), before)
  process.env["PATH"] = merged
  Effect.runSync(
    Effect.logInfo(
      `[arc] PATH repaired for packaged launch: ${before.split(":").length} → ` +
        `${merged.split(":").length} entries`,
    ),
  )
}

repairLoginPath()

/**
 * Pin this run's profile before anything touches durable state. Setting Electron's
 * `userData` moves the Chromium profile (cache, cookies, GPUCache, Partitions)
 * into the per-profile dir, and arc's domain DB resolves to a home-rooted
 * `~/.arcwork/<profile>/` path, so `pnpm dev` can never read or write the stable
 * app's database or browser profile (and vice versa). Stamping
 * `ARC_PROFILE` makes the choice explicit for child sessions — the `arc-mcp`
 * CLI launched inside a target session inherits it and resolves the same profile.
 * Must run before `runtime` is first used (app.whenReady), which it is: the
 * SqliteLive layer resolves its path lazily at build time. Honours `ARC_DB_PATH`
 * as a scratch/testing override (reported here too, so the choice is visible).
 */
function setupProfile(): void {
  const resolved = resolveArcDb()
  app.setName(APP_NAME)
  app.setPath("userData", resolved.userData)
  process.env["ARC_PROFILE"] = resolved.profile
  // Runs before the runtime is built (and thus before Lensflare exists), so this
  // goes to Effect's default console logger — early profile/DB visibility by
  // design. Effect.logInfo over raw console keeps it on the Effect logging path.
  Effect.runSync(
    Effect.logInfo(
      `[arc] profile=${resolved.profile} userData=${resolved.userData} ` +
        `db=${resolved.dbPath} (source=${resolved.source})`,
    ),
  )
}

setupProfile()

function createWindow(onReady?: (win: BrowserWindow) => void): void {
  // macOS won't honour `app.setName` for the unpackaged Electron binary (the
  // menu/dock keep showing "Electron"), so the *window title* is the only place
  // we can reliably distinguish a `pnpm dev` build from the built/preview app.
  const profile = resolveProfile()
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    title: profile === "dev" ? "Arc Work (dev)" : "Arc Work",
    webPreferences: {
      preload: path.join(dirname, "../preload/index.mjs"),
      sandbox: false,
    },
  })

  // A fresh renderer subscribes to the change streams *after* the main-process
  // streams have already emitted their current value, so re-send the snapshot
  // once the page is ready (otherwise it shows empty until the next change).
  if (onReady) win.webContents.on("did-finish-load", () => onReady(win))

  // An `target=_blank` link (a PR link, say) must reach the user's real browser,
  // not spawn a bare Electron window with no chrome. Hand http(s)/mailto URLs to
  // the OS and deny the in-app window; everything else is denied silently.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
    return { action: "deny" }
  })

  // A link the assistant wrote into the transcript — a file path rendered as
  // `[tracker.js](/Users/…/tracker.js)`, a bare PR URL — is a top-frame click,
  // not a `window.open`, so the handler above never sees it. Left unguarded it
  // navigates the whole window to that target, tearing down the running SPA (a
  // file link "opens the file in the main window"). Pin the window to its own
  // page: let it reload/re-navigate to itself, but cancel any outbound click and
  // hand it off instead — file paths to the OS opener, http(s)/mailto to the
  // real browser.
  win.webContents.on("will-navigate", (event, url) => {
    if (url === win.webContents.getURL()) return
    event.preventDefault()
    if (/^file:/i.test(url)) void shell.openPath(fileURLToPath(url))
    else if (/^(https?|mailto):/i.test(url)) void shell.openExternal(url)
  })

  const devUrl = process.env["ELECTRON_RENDERER_URL"]
  if (devUrl) {
    win.loadURL(devUrl)
  } else {
    win.loadFile(path.join(dirname, "../renderer/index.html"))
  }
}

// The renderer transport: the controller stays unaware of Electron windows and
// reaches them only through this seam.
const transport: RendererTransport = {
  broadcast: (channel, payload) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send(channel, payload)
  },
}

// Renderer→main: open a file that falls outside every open workspace (so the
// in-app editor can't show it) in the OS default app. Registered once for the
// app's lifetime — `ipcMain` is global, not per-window. The path is
// renderer-supplied, so guard the type; `shell.openPath` itself only ever opens
// with the user's configured handler and reports failures via its resolved string.
ipcMain.on(OPEN_PATH_CHANNEL, (_event, filePath: unknown) => {
  if (typeof filePath === "string" && filePath.length > 0) void shell.openPath(filePath)
})

// Dev-only: expose the renderer over the Chrome DevTools Protocol so a driver
// (Playwright `connectOverCDP`) can screenshot/click/inspect the live, HMR'd
// window. Gated on `ELECTRON_RENDERER_URL`, which electron-vite sets only in dev.
if (process.env["ELECTRON_RENDERER_URL"]) {
  app.commandLine.appendSwitch("remote-debugging-port", "9222")
}

// The controller owns all long-lived main-process orchestration. It is acquired
// into a dedicated scope at startup and that scope is closed on quit (before the
// runtime itself is disposed), so every listener, fiber, timer, socket, and PTY
// is released deterministically.
let controllerScope: Scope.Closeable | undefined
let shuttingDown = false

app.whenReady().then(async () => {
  // Serve `arc-img://` (inline tool-call images + the image viewer pane).
  registerArcImgHandler()
  controllerScope = Scope.makeUnsafe()
  // Acquired for its long-lived orchestration (hook/PTY plane, transcript
  // watchers, supersede); no return value — every renderer read streams or pulls
  // its own state, so a fresh window needs no snapshot replay.
  await runtime.runPromise(
    launchArcMainController(transport, (effect) => runtime.runFork(effect)).pipe(
      Scope.provide(controllerScope),
    ),
  )

  createWindow()
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

// Quit sequence: close the controller scope (removes IPC handlers + listeners,
// interrupts broadcast fibers, cancels artifact pollers), then dispose the
// runtime (kills child PTYs, closes hook sockets, releases the DB). Both run
// every finalizer registered against their scope.
const shutdown = async (): Promise<void> => {
  if (controllerScope) {
    await runtime.runPromise(Scope.close(controllerScope, Exit.succeed(undefined)))
  }
  await runtime.dispose()
}

app.on("before-quit", (event) => {
  if (shuttingDown) return
  event.preventDefault()
  shuttingDown = true
  void shutdown().finally(() => app.exit(0))
})

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit()
})
