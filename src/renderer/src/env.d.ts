import type { ArcApi } from "../../preload/index.js"

declare global {
  interface Window {
    // Single source of truth: the preload's exposed object (see preload/index.ts).
    // Deriving the shape here means a bridge method can't be declared on one side
    // and missing on the other — the drift the hand-written declaration allowed.
    arc: ArcApi
  }
}
