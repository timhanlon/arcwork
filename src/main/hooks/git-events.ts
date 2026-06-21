/**
 * Git branch/push → read-model refresh predicates for the `post-checkout` and
 * `pre-push` hook signals.
 *
 * When a checkout or push happens in an arc-launched shell, `.githooks/post-checkout`
 * and `.githooks/pre-push` ship a small payload over the hook socket (see their
 * `arc-*-payload.mjs` builders + the generated `arc-hook-signal.mjs`). Each
 * arrives as a {@link HookSignal} with `provider === "git"` and the event in
 * `declaredEvent`. These are opportunistic refresh triggers, not the source of
 * truth: GitHub sync + local repo identity stay authoritative.
 *
 * - post-checkout → HEAD moved (branch switch or `git worktree add`); re-detect
 *   the workspace's repo so its cached branch/head — the branch→PR map — is fresh.
 * - pre-push → a push is going out; fires before the network round-trip, so the
 *   handler schedules a debounced PR sync rather than reading GitHub immediately.
 *
 * Pure — no stores, no Effect.
 */
import type { HookSignal } from "./signals.js"

/** A branch checkout / worktree-add signal from the git provider. */
export const isCheckoutSignal = (signal: HookSignal): boolean =>
  signal.provider === "git" && signal.declaredEvent === "post-checkout"

/** A pre-push signal from the git provider (push about to leave the client). */
export const isPushSignal = (signal: HookSignal): boolean =>
  signal.provider === "git" && signal.declaredEvent === "pre-push"
