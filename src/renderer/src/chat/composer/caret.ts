/**
 * Caret coordinates for a `<textarea>`. The platform exposes a caret index
 * (`selectionStart`) but not where that index sits on screen, which the `@`
 * picker needs to anchor its popup. The standard trick: render an off-screen
 * mirror `<div>` that copies the textarea's box + text metrics, place a marker
 * span at the caret index, and measure the span. Adapted from the well-worn
 * `textarea-caret-position` approach, returning a viewport-space `DOMRect` so it
 * can be handed straight to a floating-ui virtual anchor.
 */

// The subset of computed styles that affect text wrapping/metrics. Copying these
// onto the mirror makes its line breaks land exactly where the textarea's do.
const MIRRORED_PROPERTIES = [
  "boxSizing",
  "width",
  "height",
  "overflowX",
  "overflowY",
  "borderTopWidth",
  "borderRightWidth",
  "borderBottomWidth",
  "borderLeftWidth",
  "paddingTop",
  "paddingRight",
  "paddingBottom",
  "paddingLeft",
  "fontStyle",
  "fontVariant",
  "fontWeight",
  "fontStretch",
  "fontSize",
  "fontSizeAdjust",
  "lineHeight",
  "fontFamily",
  "textAlign",
  "textTransform",
  "textIndent",
  "textDecoration",
  "letterSpacing",
  "wordSpacing",
  "tabSize",
  "whiteSpace",
  "wordWrap",
  "wordBreak",
] as const

/** Viewport-space rect of the caret at `index` within `textarea`. */
export const caretRect = (textarea: HTMLTextAreaElement, index: number): DOMRect => {
  const doc = textarea.ownerDocument
  const mirror = doc.createElement("div")
  doc.body.appendChild(mirror)

  const style = mirror.style
  const computed = window.getComputedStyle(textarea)
  style.position = "absolute"
  style.visibility = "hidden"
  style.whiteSpace = "pre-wrap"
  style.wordWrap = "break-word"
  style.top = "0"
  style.left = "0"
  for (const prop of MIRRORED_PROPERTIES) {
    style[prop] = computed[prop as keyof CSSStyleDeclaration] as string
  }
  // A textarea always wraps; force it even if the textarea has overflow set.
  style.overflow = "hidden"

  mirror.textContent = textarea.value.slice(0, index)
  const marker = doc.createElement("span")
  // A non-empty marker so it has a measurable box even at the very end of text.
  marker.textContent = textarea.value.slice(index) || "."
  mirror.appendChild(marker)

  const box = textarea.getBoundingClientRect()
  const markerTop = marker.offsetTop
  const markerLeft = marker.offsetLeft
  const lineHeight = parseFloat(computed.lineHeight) || parseFloat(computed.fontSize) || 16

  doc.body.removeChild(mirror)

  const x = box.left + markerLeft - textarea.scrollLeft
  const y = box.top + markerTop - textarea.scrollTop
  return new DOMRect(x, y, 0, lineHeight)
}
