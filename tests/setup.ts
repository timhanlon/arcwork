import { addEqualityTesters } from "@effect/vitest"

addEqualityTesters()

// Git hooks run with GIT_DIR, GIT_WORK_TREE, GIT_INDEX_FILE, … exported into the
// environment — so when `pnpm test` runs from the pre-commit hook, every test
// that shells out to `git` inherits them. Those variables OVERRIDE `-C`, so a
// test driving a throwaway repo would instead operate on THIS repo: committing,
// `checkout -b`, even `branch -D main` against the real tree. (Outside a hook the
// vars are unset, which is why it only struck on commit.) Strip them so test git
// invocations resolve to the repo they're pointed at and nothing else.
for (const key of [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_INDEX_FILE",
  "GIT_PREFIX",
  "GIT_COMMON_DIR",
  "GIT_OBJECT_DIRECTORY",
  "GIT_NAMESPACE",
  "GIT_CONFIG",
  "GIT_CONFIG_PARAMETERS",
]) {
  delete process.env[key]
}
