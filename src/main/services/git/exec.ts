import { execFile } from "node:child_process"

export interface GitResult {
  readonly stdout: string
  readonly exitCode: number
}

export interface GitCapture {
  readonly stdout: string
  readonly stderr: string
  readonly exitCode: number
}

export interface GhResult {
  readonly stdout: string
  readonly exitCode: number
  readonly errored: boolean
}

// Every git child resolves its repo from `-C <cwd>`, so any inherited GIT_*
// vars (GIT_DIR/GIT_INDEX_FILE/GIT_WORK_TREE/…) must be stripped — otherwise a
// process that itself started inside a git context (e.g. arc launched from a
// hook, or the test suite running under `git commit`'s pre-commit) would point
// git at the wrong repo. Computed once; the set is stable for the process.
const GIT_CLEAN_ENV: NodeJS.ProcessEnv = (() => {
  const env: NodeJS.ProcessEnv = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value
  }
  return env
})()

// execFile's error carries the child's exit code as a numeric `code`; a
// non-numeric code (ENOENT) means the binary wasn't found (spawn failure).
const exitCodeOf = (error: unknown): { code: number; spawnFailed: boolean } => {
  const code = (error as { code?: unknown } | null)?.code
  if (typeof code === "number") return { code, spawnFailed: false }
  return error ? { code: 1, spawnFailed: true } : { code: 0, spawnFailed: false }
}

export const runGit = (cwd: string, args: ReadonlyArray<string>): Promise<GitResult> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024, env: GIT_CLEAN_ENV },
      (error, stdout) => {
        resolve({ stdout, exitCode: exitCodeOf(error).code })
      },
    )
  })

/** Like {@link runGit} but keeps stderr — git writes failure messages there, so
 * mutations (worktree add/remove/prune) need it to surface a real error. */
export const runGitCapture = (cwd: string, args: ReadonlyArray<string>): Promise<GitCapture> =>
  new Promise((resolve) => {
    execFile(
      "git",
      ["-C", cwd, ...args],
      { maxBuffer: 64 * 1024 * 1024, env: GIT_CLEAN_ENV },
      (error, stdout, stderr) => {
        resolve({ stdout, stderr: stderr ?? "", exitCode: exitCodeOf(error).code })
      },
    )
  })

export const runGh = (cwd: string, args: ReadonlyArray<string>): Promise<GhResult> =>
  new Promise((resolve) => {
    execFile("gh", args, { cwd, maxBuffer: 64 * 1024 * 1024, env: GIT_CLEAN_ENV }, (error, stdout) => {
      // `spawnFailed` (ENOENT) means gh isn't installed — distinguish it from a
      // normal non-zero exit (e.g. not authenticated) for the log line.
      const { code, spawnFailed } = exitCodeOf(error)
      resolve({ stdout, exitCode: code, errored: spawnFailed })
    })
  })
