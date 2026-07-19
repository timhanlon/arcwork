import { describe, expect, it } from "vitest"
import {
  arcImgCacheSrc,
  arcImgFileSrc,
  contentTypeForImageExt,
  extOf,
  imageExtForMediaType,
  isImagePath,
} from "../src/shared/images.js"

describe("image helpers", () => {
  it("maps media types to file extensions", () => {
    expect(imageExtForMediaType("image/png")).toBe("png")
    expect(imageExtForMediaType("image/jpeg")).toBe("jpg")
    expect(imageExtForMediaType("image/svg+xml")).toBe("svg")
    // Unknown type → sanitized subtype, stable + filesystem-safe.
    expect(imageExtForMediaType("image/x-weird")).toBe("xweird")
  })

  it("extracts a lowercased extension", () => {
    expect(extOf("/tmp/x/TILE89.PNG")).toBe("png")
    expect(extOf("no-extension")).toBe("")
    expect(extOf("/a/.hidden")).toBe("")
  })

  it("recognizes image paths by extension", () => {
    expect(isImagePath("/private/tmp/claude-501/x/scratchpad/tile89.png")).toBe(true)
    expect(isImagePath("/a/b/shot.JPEG")).toBe(true)
    expect(isImagePath("/a/b/notes.md")).toBe(false)
    expect(isImagePath("/a/b/tracker.js")).toBe(false)
  })

  it("resolves content types for the protocol", () => {
    expect(contentTypeForImageExt("png")).toBe("image/png")
    expect(contentTypeForImageExt("jpeg")).toBe("image/jpeg")
    expect(contentTypeForImageExt("txt")).toBeUndefined()
  })

  it("builds arc-img srcs", () => {
    expect(arcImgCacheSrc("abc123", "image/png")).toBe("arc-img://cache/abc123.png")
    expect(arcImgFileSrc("/tmp/a b/tile.png")).toBe("arc-img://file/?p=%2Ftmp%2Fa%20b%2Ftile.png")
  })
})
