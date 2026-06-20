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

To observe a target CLI (Claude, Codex, Cursor), Arc Work installs a single
Arc-owned helper at `~/.arcwork/<profile>/runtime/arc-hook-signal.mjs` — outside
any repo, one copy per profile — and merges hook config pointing at it into the
provider's settings (`.claude/settings.local.json`, `.codex/hooks.json`,
`.cursor/hooks.json`). The helper no longer lands in the workspace, so it can
never show up in `git status`. Each Arc-launched shell carries `ARC_HOOK_HELPER`
(the helper's absolute path) next to `ARC_HOOK_SOCK`. One known limitation:

- **Not portable.** The merged hook commands are absolute (the Arc-owned helper
  path, plus `node` from the runner's PATH), so they only fire under Arc Work —
  instrumentation does not travel with the repo, by design. Re-running an install
  *replaces* Arc's prior hook block (matched by the helper filename) rather than
  appending, so a moved or upgraded helper leaves no orphaned stack behind.

The **MCP server** Arc exposes to those CLIs is wired repo-clean too: Claude and
Codex receive it inline on the launch command (`--mcp-config`, `-c`), writing
nothing. Cursor (which has no inline lever) instead loads an Arc-owned **plugin**
via `--plugin-dir` — one directory under `~/.arcwork/<profile>/runtime/` that
bundles both its hooks and the arc MCP server (`mcp.json`), so nothing lands in
the workspace or in `~/.cursor`. The explicit `arc-mcp <provider> --write`
command still drops a persistent repo/user config if you want one.

> The provider *hook* settings (`.claude/`, `.codex/`, `.cursor/`) are still
> merged into the repo today; relocating those out of the workspace (so a repo
> Arc opens stays byte-for-byte clean) is tracked separately.

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
