#!/usr/bin/env node
// arc-electron · git pre-push payload builder.
//
// Prints the pre-push fact as one JSON object on stdout. The `pre-push` hook
// pipes it into the generated arc hook helper (`.arc/runtime/arc-hook-signal.mjs`),
// which wraps it in the standard HookSignal envelope and ships it to the running
// app over ARC_HOOK_SOCK. arc treats it as a "push happening → sync PRs soon"
// trigger: because pre-push fires before the network round-trip, GitHub state is
// stale at this instant, so arc schedules a DEBOUNCED sync rather than reading
// immediately.
//
// The pushed refs come in on stdin (`<local ref> <local sha> <remote ref>
// <remote sha>` per line); the remote name/URL come via env, set by the hook
// from its positional args.
//
// Best-effort by contract: any failure prints nothing and exits 0, so the hook
// detects the empty payload and skips — a push must never be blocked.
import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).replace(/\n+$/, "")

try {
  // stdin (fd 0) carries the ref lines; read it synchronously and parse.
  const stdin = (() => {
    try {
      return readFileSync(0, "utf8")
    } catch {
      return ""
    }
  })()
  const refs = stdin
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [localRef, localSha, remoteRef, remoteSha] = line.split(/\s+/)
      return { localRef, localSha, remoteRef, remoteSha }
    })

  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])

  process.stdout.write(
    JSON.stringify({
      hook_event_name: "pre-push",
      remote: { name: process.env["ARC_REMOTE_NAME"] || null, url: process.env["ARC_REMOTE_URL"] || null },
      branch: branch === "HEAD" ? null : branch,
      head: git(["rev-parse", "HEAD"]),
      refs,
    }),
  )
} catch {
  // best-effort: emit nothing; the hook will skip on an empty payload.
}
process.exit(0)
