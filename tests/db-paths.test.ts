import { describe, expect, it } from "vitest"
import * as os from "node:os"
import * as path from "node:path"
import { resolveArcDb, resolveProfile } from "../src/main/db/paths.js"
import { socketPath } from "../src/main/hooks/signals.js"

// Profile/DB-path selection is the lever that keeps `pnpm dev` from touching the
// daily-driver app's database and Chromium profile. These exercise the three
// branches the acceptance criteria call out — dev, stable, and an explicit
// ARC_DB_PATH override — by passing an `env` map (no real process env, no
// Electron). The domain DB is home-rooted (`~/.arcwork/<profile>/state`) so it
// asserts on every platform; the Electron userData layout is platform-branched,
// so we gate those location asserts on the host platform.
const appSupport = path.join(os.homedir(), "Library", "Application Support")
const arcworkState = (profile: string) =>
  path.join(os.homedir(), ".arcwork", profile, "state", "arc.sqlite")
const onDarwin = process.platform === "darwin"

describe("resolveProfile", () => {
  it("honours an explicit ARC_PROFILE over everything else", () => {
    expect(resolveProfile({ ARC_PROFILE: "dev" })).toBe("dev")
    expect(resolveProfile({ ARC_PROFILE: "stable" })).toBe("stable")
    // explicit wins even when the dev heuristic would otherwise fire
    expect(resolveProfile({ ARC_PROFILE: "stable", ELECTRON_RENDERER_URL: "http://x" })).toBe(
      "stable",
    )
  })

  it("treats ELECTRON_RENDERER_URL (electron-vite dev) as the dev profile", () => {
    expect(resolveProfile({ ELECTRON_RENDERER_URL: "http://localhost:5173" })).toBe("dev")
  })

  it("defaults to stable with no signals", () => {
    expect(resolveProfile({})).toBe("stable")
  })

  it("treats any other ARC_PROFILE as an isolated sandbox profile", () => {
    // A non-blessed value is a sandbox: kept as a filesystem-safe slug, and
    // explicit still wins over the dev heuristic.
    expect(resolveProfile({ ARC_PROFILE: "weird" })).toBe("weird")
    expect(resolveProfile({ ARC_PROFILE: "weird", ELECTRON_RENDERER_URL: "x" })).toBe("weird")
    // Sanitised to the worktree-style slug (lowercased, non-alphanumerics → `-`).
    expect(resolveProfile({ ARC_PROFILE: "Pkg Test!" })).toBe("pkg-test")
  })

  it("falls back when ARC_PROFILE slugs to nothing", () => {
    expect(resolveProfile({ ARC_PROFILE: "!!!" })).toBe("stable")
    expect(resolveProfile({ ARC_PROFILE: "  ", ELECTRON_RENDERER_URL: "x" })).toBe("dev")
  })
})

describe("resolveArcDb", () => {
  it("puts the stable DB under the home-rooted ~/.arcwork/stable state dir", () => {
    const r = resolveArcDb({ ARC_PROFILE: "stable" })
    expect(r.profile).toBe("stable")
    expect(r.source).toBe("profile")
    expect(r.dbPath).toBe(arcworkState("stable"))
    if (onDarwin) {
      expect(r.userData).toBe(path.join(appSupport, "Arc Work", "stable"))
    }
  })

  it("puts the dev DB under a separate ~/.arcwork/dev state dir", () => {
    const r = resolveArcDb({ ARC_PROFILE: "dev" })
    expect(r.profile).toBe("dev")
    expect(r.source).toBe("profile")
    expect(r.dbPath).toBe(arcworkState("dev"))
    if (onDarwin) {
      expect(r.userData).toBe(path.join(appSupport, "Arc Work", "dev"))
    }
  })

  it("dev and stable never resolve to the same DB file", () => {
    expect(resolveArcDb({ ARC_PROFILE: "dev" }).dbPath).not.toBe(
      resolveArcDb({ ARC_PROFILE: "stable" }).dbPath,
    )
  })

  it("an explicit ARC_DB_PATH override pins the file but still reports the profile", () => {
    const r = resolveArcDb({ ARC_PROFILE: "dev", ARC_DB_PATH: "/tmp/scratch.sqlite" })
    expect(r.dbPath).toBe("/tmp/scratch.sqlite")
    expect(r.source).toBe("override")
    expect(r.profile).toBe("dev")
  })

  it("ignores a blank ARC_DB_PATH and falls back to the profile path", () => {
    const r = resolveArcDb({ ARC_PROFILE: "stable", ARC_DB_PATH: "   " })
    expect(r.source).toBe("profile")
  })
})

describe("hook socket paths", () => {
  it("separates dev and stable sockets for the same workspace", () => {
    const repoRoot = "/tmp/arc-workspace"
    const dev = socketPath(repoRoot, { ARC_PROFILE: "dev" })
    const stable = socketPath(repoRoot, { ARC_PROFILE: "stable" })

    expect(dev).not.toBe(stable)
    expect(path.basename(dev)).toMatch(/^arc-hook-dev-[a-f0-9]{12}\.sock$/)
    expect(path.basename(stable)).toMatch(/^arc-hook-stable-[a-f0-9]{12}\.sock$/)
  })
})
