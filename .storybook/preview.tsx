import type { Preview } from "@storybook/react-vite"
// Same stylesheets the app loads, same order: Tailwind foundation (preflight
// + @theme token mapping), then Streamdown's base styles, then styles.css
// (tokens + base element styles + .arc-markdown). This is what makes stories
// match the live renderer.
import "../src/renderer/src/tailwind.css"
import "streamdown/styles.css"
import "../src/renderer/src/styles.css"

// Storybook has no Electron preload, so `window.arc` (the IPC bridge the RPC
// atoms wait for) never attaches — `waitForBridge()` would reject after 5s,
// flipping every atom to a failure and blanking the canvas a few seconds in.
// Install an inert bridge so the gate resolves and the RPC streams just hang: a
// story seeds the atoms it needs with fixtures (RegistryProvider initialValues),
// and those values persist because nothing ever emits over the stub to replace
// them. Selection/disclosure ride the in-memory xstate machine, not the bridge.
const stubGlobal = globalThis as { arc?: Window["arc"] }
if (stubGlobal.arc === undefined) {
  const noop = (): void => {}
  const noSub = (): (() => void) => noop
  stubGlobal.arc = {
    profile: "stable",
    home: "/Users/you",
    ptyTrace: false,
    rpcSend: noop,
    onRpcMessage: noSub,
    onPtyData: noSub,
    onPtyExit: noSub,
    onAssistantStream: noSub,
    ptyWrite: noop,
    ptyResize: noop,
    ptyReportReplayed: noop,
    ptyReportDropped: noop,
  }
}

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
