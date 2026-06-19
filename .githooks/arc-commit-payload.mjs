#!/usr/bin/env node
// arc-electron · git post-commit payload builder.
//
// Prints this commit's metadata as one JSON object on stdout. The `post-commit`
// hook pipes it into the generated arc hook helper (`.arc/runtime/arc-hook-signal.mjs`),
// which wraps it in the standard HookSignal envelope (adding the inherited ARC_*
// env tags) and ships it to the running app over ARC_HOOK_SOCK. That lets arc
// correlate commit → chat → work without an agent writing a free-text note.
//
// Best-effort by contract: any failure prints nothing and exits 0, so the
// post-commit hook can detect the empty payload and skip — a commit must never
// be blocked by arc instrumentation.
import { execFileSync } from "node:child_process"

const git = (args) => execFileSync("git", args, { encoding: "utf8" }).replace(/\n+$/, "")

try {
  const sha = git(["rev-parse", "HEAD"])
  const branch = git(["rev-parse", "--abbrev-ref", "HEAD"])
  const subject = git(["log", "-1", "--format=%s"])
  const message = git(["log", "-1", "--format=%B"])
  const files = git(["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean)

  // `hook_event_name` mirrors the provider-hook payload convention so the same
  // readers can verify the event; the commit fields are arc-specific.
  process.stdout.write(
    JSON.stringify({
      hook_event_name: "post-commit",
      sha,
      branch: branch === "HEAD" ? null : branch, // detached HEAD → no branch
      subject,
      message,
      author: { name: git(["log", "-1", "--format=%an"]), email: git(["log", "-1", "--format=%ae"]) },
      committedAt: git(["log", "-1", "--format=%cI"]),
      files,
    }),
  )
} catch {
  // best-effort: emit nothing; the hook will skip on an empty payload.
}
process.exit(0)
