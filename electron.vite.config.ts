import { resolve } from "node:path"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"

const root = import.meta.dirname

export default defineConfig({
  main: {
    // node-pty is a native module — must be externalized, not bundled.
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: {
          index: resolve(root, "src/main/index.ts"),
          "raw-hook-signal-smoke": resolve(root, "src/main/smoke/raw-hook-signal-smoke.ts"),
          // The `arc-mcp` CLI: a node-side executable run via
          // `ELECTRON_RUN_AS_NODE=1 electron out/main/cli-mcp.js` (see bin/arc-mcp),
          // so it shares the app bundle when emitting MCP client config.
          "cli-mcp": resolve(root, "src/main/cli/mcp-config.ts"),
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: { input: resolve(root, "src/preload/index.ts") },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    build: {
      rollupOptions: { input: resolve(root, "src/renderer/index.html") },
    },
    plugins: [react(), tailwindcss()],
  },
})
