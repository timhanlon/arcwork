import { execFileSync } from "node:child_process"

// Delimiter that brackets PATH in the login-shell output so we can lift it out
// cleanly even when an interactive rc file prints a banner / instant prompt.
const DELIM = "_ARC_PATH_DELIM_"

/**
 * Ask the user's login shell for its real PATH.
 *
 * A double-clicked `.app` (Finder / `open`) inherits launchd's minimal PATH —
 * `/usr/bin:/bin:/usr/sbin:/sbin` — so user-installed provider CLIs (`claude`,
 * `codex`, `cursor-agent`, `pi`, living in `~/.local/bin`, Homebrew, nvm, …) are
 * unreachable and every target PTY spawn dies with `posix_spawnp failed`
 * (ENOENT). A login+interactive shell sources the same rc files a terminal does,
 * so its `$PATH` is the one the user actually has.
 *
 * Returns `undefined` on Windows, on failure, or if the delimiters are missing —
 * callers fall back to the existing PATH untouched.
 */
export function queryLoginShellPath(): string | undefined {
  if (process.platform === "win32") return undefined
  const shell = process.env["SHELL"] || "/bin/zsh"
  try {
    const out = execFileSync(
      shell,
      // login + interactive so PATH set in .zshrc/.bashrc (not just .zprofile)
      // is included; `-c` runs our delimiter-bracketed echo.
      ["-lic", `printf %s '${DELIM}'; printf %s "$PATH"; printf %s '${DELIM}'`],
      {
        encoding: "utf8",
        timeout: 5000,
        // No tty: ignore stdin so an rc file that reads it can't hang us, and
        // drop stderr so shell job-control chatter doesn't surface.
        stdio: ["ignore", "pipe", "ignore"],
        env: { ...process.env, DISABLE_AUTO_UPDATE: "true" },
      },
    )
    const start = out.indexOf(DELIM)
    const end = out.indexOf(DELIM, start + DELIM.length)
    if (start === -1 || end === -1) return undefined
    return out.slice(start + DELIM.length, end) || undefined
  } catch {
    return undefined
  }
}

/**
 * Merge the login-shell PATH ahead of the current PATH, de-duplicated and
 * order-preserving (shell dirs first so user-installed tools win). Returns the
 * merged string, or `current` unchanged when `shellPath` is empty.
 */
export function mergePath(shellPath: string | undefined, current: string): string {
  if (!shellPath) return current
  const seen = new Set<string>()
  const out: Array<string> = []
  for (const dir of [...shellPath.split(":"), ...current.split(":")]) {
    const d = dir.trim()
    if (d && !seen.has(d)) {
      seen.add(d)
      out.push(d)
    }
  }
  return out.join(":")
}
