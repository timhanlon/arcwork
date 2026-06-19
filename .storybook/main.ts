import type { StorybookConfig } from "@storybook/react-vite"
import tailwindcss from "@tailwindcss/vite"

/**
 * Storybook over the renderer's Vite. The whole reason we left Ladle: that ran
 * its own Vite with no way to mount `@tailwindcss/vite`, so Tailwind classes
 * never processed. Here `viteFinal` adds the same plugin the electron-vite
 * renderer uses, so stories render with the real utilities + @theme tokens.
 */
const config: StorybookConfig = {
  stories: ["../src/renderer/src/**/*.stories.@(ts|tsx|js|jsx)"],
  framework: { name: "@storybook/react-vite", options: {} },
  viteFinal: async (cfg) => {
    cfg.plugins = [...(cfg.plugins ?? []), tailwindcss()]
    // Don't let Vite's HMR watch arc's runtime + build output. `.arc/runtime/*`
    // (hook-signal logs) is appended to constantly by a running arc, which would
    // otherwise reload the Storybook canvas mid-interaction once per write.
    cfg.server = {
      ...cfg.server,
      watch: {
        ...cfg.server?.watch,
        ignored: ["**/.arc/**", "**/out/**", "**/.tmp/**"],
      },
    }
    return cfg
  },
}

export default config
