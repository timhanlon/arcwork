import { StrictMode } from "react"
import { createRoot } from "react-dom/client"
import { RegistryProvider } from "@effect/atom-react"
import { App } from "./App.js"
// Tailwind foundation first (preflight + @theme token mapping), then styles.css —
// whose unlayered rules win over preflight while we restyle toward utilities.
import "./tailwind.css"
import "streamdown/styles.css"
import "./styles.css"

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <RegistryProvider>
      <App />
    </RegistryProvider>
  </StrictMode>,
)
