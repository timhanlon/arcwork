import type { JSX } from "react"
import { useState } from "react"

export interface ImageViewProps {
  /** The image source — an `arc-img://` URL, a `data:` URI, or any loadable src. */
  readonly src: string
  /** Optional caption shown in a thin header bar (e.g. the file name). */
  readonly title?: string
  readonly className?: string
}

/**
 * A domain-free image viewer: fits one picture inside its pane (letterboxed on a
 * neutral checkerboard so transparency reads), with an optional caption bar. A
 * load failure shows a one-line message rather than a broken-image glyph — the
 * common cause is a cache miss (`arc-img://cache/…` for an image never ingested)
 * or a since-deleted file behind an `arc-img://file/…` src.
 */
export function ImageView({ src, title, className }: ImageViewProps): JSX.Element {
  const [failed, setFailed] = useState(false)
  // A 2px checkerboard so a transparent PNG is legible against the pane.
  const checker =
    "repeating-conic-gradient(var(--elev) 0% 25%, transparent 0% 50%) 50% / 16px 16px"
  return (
    <div className={`flex min-h-0 flex-col ${className ?? ""}`}>
      {title && (
        <div className="flex-none truncate border-b border-border bg-elev/40 px-2 py-1 font-mono text-[11px] text-fg-dim">
          {title}
        </div>
      )}
      <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto p-3" style={{ background: checker }}>
        {failed ? (
          <div className="text-[12px] text-fg-dim">Image unavailable</div>
        ) : (
          <img
            src={src}
            alt={title ?? ""}
            onError={() => setFailed(true)}
            className="max-h-full max-w-full object-contain"
          />
        )}
      </div>
    </div>
  )
}
