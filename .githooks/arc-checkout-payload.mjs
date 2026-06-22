#!/usr/bin/env node
// arc-electron · git post-checkout payload builder.
//
// Prints the post-checkout fact as one JSON object on stdout. The `post-checkout`
// hook pipes it into the generated arc hook helper (`.arc/runtime/arc-hook-signal.mjs`),
// which wraps it in the standard HookSignal envelope (adding the inherited ARC_*
// env tags) and ships it to the running app over ARC_HOOK_SOCK. arc uses it as
// an opportunistic "branch moved, remap branch→PR" trigger for the workspace at
// this cwd — the durable PR read model stays GitHub-synced, this just nudges it.
//
// The prev/new HEAD refs come in via env (ARC_PREV_HEAD / ARC_NEW_HEAD) because
// git passes them as positional hook args, not on stdin.
//
// Best-effort by contract: any failure prints nothing and exits 0, so the hook
// detects the empty payload and skips — a checkout must never be blocked.
import { execFileSync } from "node:child_process"

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).replace(/\n+$/, "")

try {
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])

  // `hook_event_name` mirrors the provider-hook payload convention so the same
  // readers can verify the event; the checkout fields are arc-specific.
  process.stdout.write(
    JSON.stringify({
      hook_event_name: "post-checkout",
      prevHead: process.env["ARC_PREV_HEAD"] || null,
      newHead: process.env["ARC_NEW_HEAD"] || null,
      branch: branch === "HEAD" ? null : branch, // detached HEAD → no branch
      head: git(["rev-parse", "HEAD"]),
    }),
  )
} catch {
  // best-effort: emit nothing; the hook will skip on an empty payload.
}
process.exit(0)
