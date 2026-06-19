/**
 * Git commit → work mapping for the `post-commit` hook signal.
 *
 * When a commit is made from an arc-launched shell, `.githooks/post-commit`
 * ships its metadata over the hook socket (see `.githooks/arc-commit-payload.mjs`
 * + the generated `arc-hook-signal.mjs`). It arrives as a {@link HookSignal} with
 * `provider === "git"` and the commit fields in `hookInput`. This module turns
 * that signal into a structured {@link CommitFact} and picks which of a chat's
 * work items the commit should be stamped onto. Pure — no stores, no Effect.
 *
 * The commit citation it feeds is the typed replacement for the hand-written
 * "Committed as `<sha>`" notes agents used to leave (work_01kv9vwvz2e4dsss6qypgqxx74).
 */
import type { HookSignal } from "./signals.js"
import { OPEN_WORK_STATUSES, type Work } from "../../shared/work.js"

export interface CommitFact {
  readonly sha: string
  readonly branch: string | null
  readonly subject: string
  readonly message: string
  readonly files: ReadonlyArray<string>
  readonly author: { readonly name: string | null; readonly email: string | null }
  readonly committedAt: string | null
}

const str = (v: unknown): string | null => (typeof v === "string" && v.length > 0 ? v : null)

const hookInputObj = (signal: HookSignal): Record<string, unknown> | null =>
  signal.hookInput && typeof signal.hookInput === "object" && !Array.isArray(signal.hookInput)
    ? (signal.hookInput as Record<string, unknown>)
    : null

/** A commit signal: the git provider's post-commit event carrying a sha. */
export const isCommitSignal = (signal: HookSignal): boolean =>
  signal.provider === "git" &&
  signal.declaredEvent === "post-commit" &&
  str(hookInputObj(signal)?.["sha"]) !== null

/** Extract the commit fact from a git post-commit signal, or null if malformed. */
export const commitFromSignal = (signal: HookSignal): CommitFact | null => {
  const input = hookInputObj(signal)
  const sha = str(input?.["sha"])
  if (!input || !sha) return null
  const author = input["author"]
  const authorObj = author && typeof author === "object" ? (author as Record<string, unknown>) : null
  return {
    sha,
    branch: str(input["branch"]),
    subject: str(input["subject"]) ?? "",
    message: str(input["message"]) ?? str(input["subject"]) ?? "",
    files: Array.isArray(input["files"])
      ? input["files"].filter((f): f is string => typeof f === "string" && f.length > 0)
      : [],
    author: { name: str(authorObj?.["name"]), email: str(authorObj?.["email"]) },
    committedAt: str(input["committedAt"]),
  }
}

const OPEN = new Set<string>(OPEN_WORK_STATUSES)

/**
 * Which work item a commit lands on, given a chat's work. There is no explicit
 * "active work" pointer, so the heuristic is: the most-recently-updated *open*
 * (open/active/blocked) item — the one the agent is plausibly working — falling
 * back to the most-recently-updated item of any status. Returns null when the
 * chat has no work at all, in which case the commit stays a repo-level event
 * with no citation, which is the correct outcome.
 */
export const pickWorkForCommit = (works: ReadonlyArray<Work>): Work | null => {
  if (works.length === 0) return null
  const byRecency = [...works].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  return byRecency.find((w) => OPEN.has(w.status)) ?? byRecency[0]!
}

/** A short human note for the citation, e.g. `dev: fix(ids): drop shortId`. */
export const commitCitationNote = (commit: CommitFact): string =>
  commit.branch ? `${commit.branch}: ${commit.subject}` : commit.subject
