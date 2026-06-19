import type { Preview } from "@storybook/react-vite"
// Same stylesheets the app loads, same order: Tailwind foundation (preflight
// + @theme token mapping), then Streamdown's base styles, then styles.css
// (tokens + base element styles + .arc-markdown). This is what makes stories
// match the live renderer.
import "../src/renderer/src/tailwind.css"
import "streamdown/styles.css"
import "../src/renderer/src/styles.css"

const preview: Preview = {
  parameters: {
    layout: "fullscreen",
    controls: { matchers: { color: /(background|color)$/i, date: /Date$/i } },
  },
  // App is dark-only — wrap every story in the same dark surface the old Ladle
  // Provider gave, so tokens like var(--bg)/var(--fg) read correctly.
  decorators: [
    (Story) => (
      <div style={{ background: "var(--bg)", color: "var(--fg)", minHeight: "100vh", padding: 16 }}>
        <Story />
      </div>
    ),
  ],
}

export default preview
