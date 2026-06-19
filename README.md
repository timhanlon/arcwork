# Arc Work

[![CI](https://github.com/timhanlon/arcwork/actions/workflows/ci.yml/badge.svg)](https://github.com/timhanlon/arcwork/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

Arc Work is an Electron app for working with local agent CLIs from a unified
workspace.

> **Status:** early release (`0.0.1`), macOS-only, distributed source-only —
> run it with `pnpm dev` (see below). No packaged build yet.

## Requirements

- Node.js 22 or newer
- pnpm 10.11.1 or newer
- macOS for the current Electron development target

## Development

```bash
pnpm install
pnpm dev
```

Useful commands:

```bash
pnpm typecheck
pnpm test
pnpm build
pnpm storybook
```

Launching a live session needs `node-pty` and `better-sqlite3` compiled for
Electron's ABI. `pnpm install` builds them; if a native-module ABI error appears
on launch, rebuild them explicitly:

```bash
pnpm rebuild   # electron-rebuild -f -w node-pty,better-sqlite3
```

## Project Layout

```text
src/main/       Electron main process, storage, hooks, MCP, and services
src/preload/    Electron preload bridge
src/renderer/   React renderer
src/shared/     shared schemas and types
tests/          Vitest coverage
```

Runtime state is local-only and ignored by git.

### Hook instrumentation

To observe a target CLI (Claude, Codex, Cursor), Arc Work installs repo-local hooks
into the workspace it launches: a generated helper at
`.arc/runtime/arc-hook-signal.mjs`, plus hook config merged into the provider's
repo-local settings (`.claude/settings.local.json`, `.codex/hooks.json`,
`.cursor/hooks.json`). Both are gitignored, so Arc Work's instrumentation never shows
up in `git status`. Two known limitations:

- **Not portable.** The helper path and hook commands are absolute (the workspace
  root, plus `node` from the runner's PATH), so a fresh clone or a moved repo
  needs Arc Work to reinstall them — instrumentation does not travel with the repo.
- **Install only appends.** The merge dedupes by exact command string and never
  removes stale entries, so a changed path or an older helper leaves an orphaned
  hook stack firing alongside the current one (and growing `.arc/runtime/`
  unbounded). If you see double-captured events or an `.arc/runtime` file growing
  without bound, prune the stale blocks from the provider settings by hand.

## Contributing

Bug reports and small focused fixes are welcome. See
[CONTRIBUTING.md](CONTRIBUTING.md) for setup and the checks CI runs, and
[SECURITY.md](SECURITY.md) to report vulnerabilities privately.

## Profiles: dev vs stable state

`pnpm dev` and the built/preview app keep **separate** durable state, so a dev
rebuild, half-run migration, or crash can never touch the database or Chromium
profile of the app you rely on daily. State is split two ways (resolved by
`src/main/db/paths.ts`; `src/main/index.ts` pins `app.setPath("userData", …)` at
boot):

- **Domain DB** — home-rooted under `~/.arcwork/<profile>/`, easy to inspect,
  back up, and reset from CLI/MCP workflows.
- **Electron profile** (cache, cookies, GPUCache, partitions, window state) —
  per-profile under one `Arc Work` `userData` app dir.

| Profile  | Selected by                        | DB file                              | Electron `userData`                             |
| -------- | ---------------------------------- | ------------------------------------ | ----------------------------------------------- |
| `stable` | `pnpm start` (preview), or default | `~/.arcwork/stable/state/arc.sqlite` | `~/Library/Application Support/Arc Work/stable` |
| `dev`    | `pnpm dev` (`ARC_PROFILE=dev`)     | `~/.arcwork/dev/state/arc.sqlite`    | `~/Library/Application Support/Arc Work/dev`    |

- `ARC_PROFILE=dev|stable` forces the profile; otherwise the presence of
  `ELECTRON_RENDERER_URL` (set only by `electron-vite dev`) means dev.
- `ARC_DB_PATH=/path/to.sqlite` overrides the DB file outright (scratch/testing);
  the Chromium profile still follows `ARC_PROFILE`.
- The resolved profile + DB path are logged at startup (`[arc] profile=… db=…`).
- Migration is manual: there's no automatic move of pre-existing files. To carry
  over old state, copy your DB to the new path by hand once.
