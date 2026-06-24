# Effect v4 reference docs (vendored)

Canonical, Effect-team-authored guidance for writing idiomatic **Effect v4**,
copied into this repo so it's present in **every worktree** and pinned alongside
our dependency — rather than depending on a clone under `.tmp/` that only ever
exists in the main checkout.

**Read this before writing or reviewing Effect code.** Start with
[`patterns/effect.md`](./patterns/effect.md) and [`LLMS.md`](./LLMS.md); use
[`ai-docs/`](./ai-docs/) for runnable, topic-by-topic examples; consult
[`MIGRATION.md`](./MIGRATION.md) when you hit a v3-era API.

## Provenance

| | |
|---|---|
| Source | [`Effect-TS/effect-smol`](https://github.com/Effect-TS/effect-smol) |
| Commit | `3e3a859ec6351a9e0d31674aabbd48fcefabb12e` |
| Our `effect` pin | `4.0.0-beta.74` |
| License | MIT © 2023 Effectful Technologies Inc (see [LICENSE](./LICENSE)) |

This is a **snapshot**. It does not auto-update; it will drift from upstream and
from our `effect` pin. When bumping `effect`, refresh it:

```sh
git clone --depth 1 https://github.com/Effect-TS/effect-smol .tmp/effect-smol
cp .tmp/effect-smol/.patterns/effect.md   docs/effect/patterns/effect.md
cp .tmp/effect-smol/.patterns/testing.md  docs/effect/patterns/testing.md
cp .tmp/effect-smol/LLMS.md               docs/effect/LLMS.md
cp .tmp/effect-smol/MIGRATION.md          docs/effect/MIGRATION.md
rm -rf docs/effect/ai-docs && cp -R .tmp/effect-smol/ai-docs/src docs/effect/ai-docs
# then update the Commit / pin rows above
```

## What was deliberately left out

- `.patterns/jsdoc.md` and `.agents/skills/jsdocs/` — Effect's own *contribution*
  conventions for documenting the Effect source. Repo-specific, not ours.
- ai-docs build scaffolding (`package.json`, `tsconfig.json`).

The vendored `ai-docs/*.ts` files are **reference examples**, not part of the
build: `docs/**` is outside `tsconfig.json`'s `include` and `vitest`'s test glob,
and `docs/effect/**` is in oxlint's `ignorePatterns`, so they are not
typechecked, tested, or linted against our rules.

## ai-docs sections, mapped to our stack

Our app is an Electron main (Effect v4) + React renderer over a typed RPC seam.
The most load-bearing sections for that:

- `01_effect/` — basics (`Effect.gen`/`Effect.fn`), services & layers, the error
  model (`Schema.TaggedError`, `catch*`, reason errors), resources
  (`acquireRelease`, scoped layers), running, pubsub. **Core.**
- `02_stream/`, `03_integration/` (managed runtime) — transcript/live projections.
- `07_datetime/` — use `DateTime`/`Clock`, never `Date.now()` inside Effects.
- `08_observability/` — logging + OTLP tracing (our Lensflare seam).
- `09_testing/` — `it.effect`, layer tests, `TestClock`.
- `60_child-process/` — session/pty spawning with finalizers.

Also vendored and valid Effect idiom, but not central to our stack today (kept
for completeness — we use `@effect/rpc`, not an HTTP server): `05_batching/`,
`06_schedule/`, `50_http-client/`, `51_http-server/`, `70_cli/`, `71_ai/`,
`80_cluster/`.

## Relationship to `docs/effect-idiom-audit.md`

These docs are the "**do it right**" source of truth. The audit is the
"**catch it when we don't**" companion — mined anti-patterns from our own history,
each tagged for an ast-grep rule, a review heuristic, or a memory note. Both
serve work_01kvrmq7m4fvgb8q8ehcqbf4dx (better agent guidance about Effect).
