import * as os from "node:os"
import * as path from "node:path"

/**
 * Resolve where arc's durable state lives — split by *profile* so dev and the
 * daily-driver app never share a database or a Chromium profile.
 *
 * `pnpm dev` rebuilds, runs unfinished migrations, crashes, and litters
 * experiments; the built/preview app is the one a human relies on. If both
 * pointed at one DB (the old behaviour — a repo-local `.arc/state/arc.sqlite`),
 * a dev mishap could corrupt real history. So state is split two ways:
 *
 *   • Arc Work's *domain* DB lives under a home-rooted `~/.arcwork/<profile>/`,
 *     which is trivial for CLI/MCP/shared-agent workflows to inspect, back up,
 *     reset, and document:
 *
 *       stable  ~/.arcwork/stable/state/arc.sqlite
 *       dev     ~/.arcwork/dev/state/arc.sqlite
 *
 *   • Electron *profile* data (cache, cookies, GPUCache, partitions, window
 *     state) stays in Electron's `userData`, kept per-profile under one app dir:
 *
 *       stable  ~/Library/Application Support/Arc Work/stable
 *       dev     ~/Library/Application Support/Arc Work/dev
 *
 * This module is **Electron-free on purpose**: the `arc-mcp` CLI imports it
 * while running under `ELECTRON_RUN_AS_NODE=1` (plain Node, no `app` object), so
 * resolution must work off `process.env` and platform conventions alone. The
 * Electron main process pins `app.setPath("userData", …)` to the exact same dir
 * (see src/main/index.ts), keeping the two in lockstep.
 */

export type ArcProfile = "dev" | "stable"

/**
 * Electron `app.getName()` value. Shared across profiles — the profile is a
 * subdirectory under it, not a separate app folder.
 */
export const APP_NAME = "Arc Work"

/** Home-rooted base dir holding Arc Work's domain-owned durable state. */
const ARCWORK_DIRNAME = ".arcwork"

export const ARC_DB_FILENAME = "arc.sqlite"

/**
 * Which profile are we? Explicit `ARC_PROFILE=dev|stable` wins; otherwise we
 * treat the presence of `ELECTRON_RENDERER_URL` (which electron-vite sets only
 * under `pnpm dev`) as dev, and default to stable. The app stamps the resolved
 * value back onto `process.env.ARC_PROFILE`, so sessions it launches — and the
 * `arc-mcp` CLI inside them — inherit and agree on the same profile.
 */
export const resolveProfile = (env: NodeJS.ProcessEnv = process.env): ArcProfile => {
  const explicit = env["ARC_PROFILE"]?.trim().toLowerCase()
  if (explicit === "dev" || explicit === "stable") return explicit
  if (env["ELECTRON_RENDERER_URL"]) return "dev"
  return "stable"
}

/** The per-platform base Electron uses for `userData` (its `appData` path). */
const appDataBase = (env: NodeJS.ProcessEnv): string => {
  switch (process.platform) {
    case "darwin":
      return path.join(os.homedir(), "Library", "Application Support")
    case "win32":
      return env["APPDATA"] ?? path.join(os.homedir(), "AppData", "Roaming")
    default:
      return env["XDG_CONFIG_HOME"] ?? path.join(os.homedir(), ".config")
  }
}

/**
 * The profile's Electron `userData` directory — where the Chromium profile
 * (cache, cookies, GPUCache, partitions, window state) lives. Per-profile under
 * a single `Arc Work` app dir.
 */
export const userDataDir = (
  profile: ArcProfile,
  env: NodeJS.ProcessEnv = process.env,
): string => path.join(appDataBase(env), APP_NAME, profile)

/** The profile's home-rooted Arc Work state dir (the domain DB lives here). */
export const arcWorkStateDir = (profile: ArcProfile): string =>
  path.join(os.homedir(), ARCWORK_DIRNAME, profile, "state")

/**
 * The profile's home-rooted Arc Work *runtime* dir — Arc-owned, regenerable
 * scratch that must live outside any target repo. The hook helper script lives
 * here (one copy per profile, not one per workspace), so a repo Arc opens never
 * gets an Arc-owned executable written into it.
 */
export const arcWorkRuntimeDir = (profile: ArcProfile): string =>
  path.join(os.homedir(), ARCWORK_DIRNAME, profile, "runtime")

/**
 * The profile's home-rooted Arc Work *worktrees* dir — where arc-managed git
 * worktrees are created, one tree per repo/branch. Arc owns these directories
 * (create on `worktree add`, remove on prune), so they live outside any source
 * checkout rather than as siblings the user has to clean up.
 */
export const arcWorkWorktreesDir = (
  profile: ArcProfile,
  env: NodeJS.ProcessEnv = process.env,
): string => {
  // `ARC_WORKTREES_DIR` is an escape hatch (tests, sandboxing) that pins the
  // managed-worktree root outright — the worktree analogue of `ARC_DB_PATH`.
  const override = env["ARC_WORKTREES_DIR"]?.trim()
  if (override && override.length > 0) return override
  return path.join(os.homedir(), ARCWORK_DIRNAME, profile, "worktrees")
}

/** Filesystem-safe slug for a repo or branch segment of a managed worktree path:
 * lowercased, non-alphanumerics collapsed to `-`, trimmed. `feat/git` →
 * `feat-git`, so a branch with slashes never spawns nested directories. */
export const worktreeSlug = (value: string): string =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "x"

/** Absolute path for an arc-managed worktree of `branch` under `repoSlug`:
 * `~/.arcwork/<profile>/worktrees/<repoSlug>/<branchSlug>`. */
export const arcWorkWorktreePath = (
  profile: ArcProfile,
  repoSlug: string,
  branch: string,
): string => path.join(arcWorkWorktreesDir(profile), worktreeSlug(repoSlug), worktreeSlug(branch))

export interface ResolvedDbPath {
  /** The profile that was selected. */
  readonly profile: ArcProfile
  /** The profile's Electron userData directory (Chromium profile data). */
  readonly userData: string
  /** Absolute path to the SQLite file arc will open. */
  readonly dbPath: string
  /** `override` when `ARC_DB_PATH` forced the file; `profile` otherwise. */
  readonly source: "override" | "profile"
}

/**
 * Resolve the full DB picture: profile, userData dir, and the file to open.
 * `ARC_DB_PATH` is an escape hatch for scratch/testing — when set it pins the
 * file outright (the profile/userData are still reported, for diagnostics).
 */
export const resolveArcDb = (env: NodeJS.ProcessEnv = process.env): ResolvedDbPath => {
  const profile = resolveProfile(env)
  const userData = userDataDir(profile, env)
  const override = env["ARC_DB_PATH"]?.trim()
  if (override && override.length > 0) {
    return { profile, userData, dbPath: override, source: "override" }
  }
  return {
    profile,
    userData,
    dbPath: path.join(arcWorkStateDir(profile), ARC_DB_FILENAME),
    source: "profile",
  }
}

/** Absolute path to arc's domain database for the current environment. */
export const arcDbPath = (env: NodeJS.ProcessEnv = process.env): string =>
  resolveArcDb(env).dbPath
