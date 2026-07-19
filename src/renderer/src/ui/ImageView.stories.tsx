import { ImageView } from "./ImageView.js"

export default {
  title: "Components / ImageView",
}

// An inline SVG data URI so the story renders with no `arc-img://` protocol (that
// only exists in the Electron main process, not Storybook/Vite).
const sample =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    `<svg xmlns="http://www.w3.org/2000/svg" width="480" height="300">
       <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
         <stop offset="0" stop-color="#7dd3fc"/><stop offset="1" stop-color="#c084fc"/>
       </linearGradient></defs>
       <rect width="480" height="300" fill="url(#g)"/>
       <circle cx="240" cy="150" r="80" fill="rgba(255,255,255,0.35)"/>
       <text x="240" y="158" font-family="monospace" font-size="20" fill="#1e293b"
         text-anchor="middle">tile89.png</text>
     </svg>`,
  )

/** A picture fitted to its pane with a caption bar. */
export const WithTitle = () => (
  <div style={{ height: 360, width: 520, border: "1px solid var(--border)" }}>
    <ImageView src={sample} title="tile89.png" className="h-full" />
  </div>
)

/** No caption — the picture fills the whole pane. */
export const NoTitle = () => (
  <div style={{ height: 360, width: 520, border: "1px solid var(--border)" }}>
    <ImageView src={sample} className="h-full" />
  </div>
)

/** A src that can't load (cache miss / deleted file) falls back to a message. */
export const Unavailable = () => (
  <div style={{ height: 200, width: 520, border: "1px solid var(--border)" }}>
    <ImageView src="arc-img://cache/deadbeef.png" title="missing.png" className="h-full" />
  </div>
)
