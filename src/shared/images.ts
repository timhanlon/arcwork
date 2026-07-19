// Image helpers shared across the seam: the ingest store writes cached bytes as
// `<hash>.<ext>`, the renderer builds an `arc-img://cache/<hash>.<ext>` src, and
// the main-process `arc-img` protocol maps an extension back to a Content-Type
// and guards which file paths it will serve. Keeping the media-type ↔ extension
// mapping in one place stops the three sides from drifting.

/** Known media type → file extension (no dot). */
const MEDIA_TYPE_TO_EXT: Readonly<Record<string, string>> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
}

/** Extension (no dot, lowercased) → Content-Type for the `arc-img` protocol. */
const EXT_TO_CONTENT_TYPE: Readonly<Record<string, string>> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  bmp: "image/bmp",
  svg: "image/svg+xml",
}

/**
 * File extension for a cached image's media type. Falls back to the sanitized
 * subtype (`image/x-foo` → `x-foo`), then `bin`, so an unmapped type still gets
 * a stable, filesystem-safe name.
 */
export const imageExtForMediaType = (mediaType: string): string => {
  const known = MEDIA_TYPE_TO_EXT[mediaType.toLowerCase()]
  if (known) return known
  const subtype = mediaType.split("/")[1]?.replace(/[^a-z0-9]+/gi, "").toLowerCase()
  return subtype && subtype.length > 0 ? subtype : "bin"
}

/** The `.ext` (lowercased, no dot) of a path, or "" when it has none. */
export const extOf = (p: string): string => {
  const base = p.split(/[\\/]/).pop() ?? p
  const dot = base.lastIndexOf(".")
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : ""
}

/** Content-Type for a cached/served image by its extension, or undefined when unknown. */
export const contentTypeForImageExt = (ext: string): string | undefined => EXT_TO_CONTENT_TYPE[ext.toLowerCase()]

/** Whether a path names an image we can render in-app (by extension). */
export const isImagePath = (p: string): boolean => contentTypeForImageExt(extOf(p)) !== undefined

/** `<img>` src for a persisted (content-addressed) image — served from the ingest
 * cache by the main-process `arc-img` protocol. */
export const arcImgCacheSrc = (hash: string, mediaType: string): string =>
  `arc-img://cache/${hash}.${imageExtForMediaType(mediaType)}`

/** `<img>` src for a live image file by absolute path — served (guarded to image
 * files) by the `arc-img` protocol, for the file-link viewer pane. */
export const arcImgFileSrc = (absPath: string): string =>
  `arc-img://file/?p=${encodeURIComponent(absPath)}`
