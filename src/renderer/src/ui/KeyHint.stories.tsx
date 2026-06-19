import { KeyHint } from "./KeyHint.js"

export default {
  title: "Components / KeyHint",
}

/** The nine jump slots, ⌘1…⌘9 (Command glyph on macOS, Control elsewhere). */
export const Slots = () => (
  <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
    {[1, 2, 3, 4, 5, 6, 7, 8, 9].map((slot) => (
      <KeyHint key={slot} slot={slot} />
    ))}
  </div>
)
