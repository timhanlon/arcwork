import { protocol } from "electron"
import { readFile, stat } from "node:fs/promises"
import * as path from "node:path"
import { contentTypeForImageExt, extOf, isImagePath } from "../../shared/images.js"
import { arcWorkImagesDir, resolveProfile } from "../db/paths.js"

/**
 * The `arc-img://` scheme serves image bytes into the renderer's `<img>` tags —
 * the pictures a tool result carried (a Read of a `.png`, a browser screenshot),
 * which we now render inline instead of the old `[image]` placeholder. Two forms:
 *
 *   • `arc-img://cache/<hash>.<ext>` — a persisted image from the content-addressed
 *     ingest cache (`arcWorkImagesDir`). This is the durable source: it survives
 *     the `/tmp` scratchpad being cleared and covers browser screenshots (which
 *     never had a file path).
 *   • `arc-img://file/?p=<abs-path>` — a live image file by absolute path, for
 *     opening an image file-link (including outside every workspace, e.g. `/tmp`)
 *     in the in-app viewer pane. The live-path counterpart to the existing
 *     arbitrary-path `arc:open-path` IPC, restricted here to image files + a size
 *     cap so it can only ever return pictures.
 */
export const ARC_IMG_SCHEME = "arc-img"

/** Refuse absurdly large reads — a preview/viewer, not a blob loader. */
const MAX_IMAGE_BYTES = 25 * 1024 * 1024

/** A cache filename is a bare `<hex-hash>.<ext>` — no separators, no `..`. */
const CACHE_NAME = /^[a-f0-9]{16,}\.[a-z0-9]+$/

const notFound = (): Response => new Response(null, { status: 404 })

/**
 * Register the `arc-img` scheme as privileged. MUST run at module load, before
 * `app.whenReady()` — Electron only accepts scheme privileges before the app is
 * ready. `standard` gives real URL parsing (host/pathname/search); `secure` puts
 * it in a secure context so the renderer loads it without mixed-content fuss.
 */
export const registerArcImgScheme = (): void => {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARC_IMG_SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true },
    },
  ])
}

const serveFile = async (file: string, ext: string): Promise<Response> => {
  // Known image extension → its exact type. A cache file can carry an extension
  // we don't map (an exotic `imageExtForMediaType` fallback like `xicon`); it's
  // still a picture we ingested, so serve it with a best-effort `image/<ext>`
  // rather than 404 — browsers content-sniff `<img>` anyway. The file-link path
  // never reaches this branch: its caller gates on the strict `isImagePath`.
  const contentType = contentTypeForImageExt(ext) ?? `image/${ext}`
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_IMAGE_BYTES) return notFound()
    const bytes = await readFile(file)
    return new Response(bytes, { headers: { "content-type": contentType } })
  } catch {
    return notFound()
  }
}

/**
 * Install the `arc-img` request handler. Call once after `app.whenReady()`. The
 * profile (and thus the cache dir) is fixed for the process, so it's resolved
 * once here.
 */
export const registerArcImgHandler = (): void => {
  const imagesDir = arcWorkImagesDir(resolveProfile())
  protocol.handle(ARC_IMG_SCHEME, async (request) => {
    let url: URL
    try {
      url = new URL(request.url)
    } catch {
      return notFound()
    }
    if (url.host === "cache") {
      const name = url.pathname.replace(/^\/+/, "")
      // Content-addressed filename only — this can't be steered to read an
      // arbitrary file (no separators, no `..`), so the cache dir is a hard jail.
      if (!CACHE_NAME.test(name)) return notFound()
      return serveFile(path.join(imagesDir, name), extOf(name))
    }
    if (url.host === "file") {
      const p = url.searchParams.get("p")
      // Absolute image paths only. This is the same trust posture as the existing
      // `arc:open-path` IPC (arbitrary renderer-supplied path → OS opener), narrowed
      // to image files that we read and return rather than hand to a launcher.
      if (!p || !path.isAbsolute(p) || !isImagePath(p)) return notFound()
      return serveFile(p, extOf(p))
    }
    return notFound()
  })
}
