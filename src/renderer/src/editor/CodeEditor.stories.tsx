import { useState } from "react"
import { CodeEditor } from "./CodeEditor.js"

export default {
  title: "Editor / CodeEditor",
}

const SAMPLE_TS = `import { Effect } from "effect"

// A read-only Monaco view, themed to match the diff pane (vitesse-dark via Shiki).
export const greet = (name: string): Effect.Effect<string> =>
  Effect.gen(function* () {
    const upper = name.trim().toUpperCase()
    yield* Effect.log(\`hello \${upper}\`)
    return upper
  })

const counts: Record<string, number> = { open: 5, done: 3 }
for (const [k, v] of Object.entries(counts)) {
  console.log(k, v > 0 ? "has work" : "clear")
}
`

const SAMPLE_JSON = `{
  "name": "arc-work",
  "private": true,
  "scripts": { "dev": "electron-vite dev" },
  "deps": ["effect", "monaco-editor", "shiki"]
}
`

/**
 * A TypeScript file in the read-only editor — Shiki tokenisation through Monaco,
 * the same `vitesse-dark` colours the diff view uses. A fixed height stands in
 * for the pane the editor will fill in the app.
 */
export const TypeScript = () => (
  <div style={{ height: 360, border: "1px solid var(--border)" }}>
    <CodeEditor value={SAMPLE_TS} language="typescript" className="h-full" />
  </div>
)

/** Confirms language switching retags the live model (the editor isn't recreated):
 * toggle the language and the same buffer recolours. */
export const LanguageSwitch = () => {
  const [lang, setLang] = useState<"typescript" | "json">("typescript")
  const value = lang === "typescript" ? SAMPLE_TS : SAMPLE_JSON
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
      <div style={{ display: "flex", gap: 6 }}>
        <button onClick={() => setLang("typescript")}>typescript</button>
        <button onClick={() => setLang("json")}>json</button>
      </div>
      <div style={{ height: 320, border: "1px solid var(--border)" }}>
        <CodeEditor value={value} language={lang} className="h-full" />
      </div>
    </div>
  )
}

/** Plaintext fallback: a file we don't bundle a grammar for still opens, just
 * uncoloured. */
export const Plaintext = () => (
  <div style={{ height: 200, border: "1px solid var(--border)" }}>
    <CodeEditor value={"just some\nunhighlighted\nlines of text\n"} language="plaintext" className="h-full" />
  </div>
)
