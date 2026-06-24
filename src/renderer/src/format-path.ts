/**
 * Display helper: collapse the running user's home directory to `~`, so paths
 * read the way they do in a shell. Only this user's own home is abbreviated
 * (`/Users/you/dev/aux` → `~/dev/aux`); another account's `/Users/other/…`
 * stays literal, since it isn't theirs to shorten. Renderer-only — the home dir
 * rides the preload bridge (`window.arc.home`, stamped from `$HOME`).
 */
export const homePath = (): string => window.arc?.home ?? ""

export function tildify(path: string, home: string = homePath()): string {
  if (!home) return path
  if (path === home) return "~"
  return path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path
}
