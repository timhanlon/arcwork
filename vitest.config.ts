import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    setupFiles: ["tests/setup.ts"],
    // The app's `better-sqlite3` is a native addon built for Electron's ABI and
    // won't load under the plain-Node test runner. Tests run against Node's
    // built-in `node:sqlite` via a thin drop-in, so the real ArcStore SQL is
    // exercised with no native build or ABI mismatch. See the shim's header.
    alias: {
      "better-sqlite3": fileURLToPath(new URL("./tests/better-sqlite3-node-shim.ts", import.meta.url)),
    },
    // The alias only rewrites imports that pass through vite's transform, so the
    // Effect sqlite client must be inlined rather than loaded as an external
    // node module — otherwise its own `better-sqlite3` import bypasses the alias.
    server: {
      deps: {
        inline: ["@effect/sql-sqlite-node"],
      },
    },
  },
})
