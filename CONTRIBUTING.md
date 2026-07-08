# Contributing to Arc Work

Thanks for your interest in Arc Work. This is an early release (`0.0.1`) and the
internals are still moving, so the most useful contributions right now are bug
reports, reproductions, and small focused fixes.

## Getting set up

```bash
pnpm install
pnpm dev
```

Arc Work is currently a macOS-only Electron app and is distributed source-only —
there is no packaged build yet. You need:

- Node.js 22 or newer
- pnpm 10.11.1 or newer
- Xcode command-line tools (for compiling the native modules)

Launching a live session compiles `node-pty` and `better-sqlite3` against
Electron's ABI during `pnpm install`. If you hit a native-module ABI error on
launch, rebuild them:

```bash
pnpm rebuild
```

## Before you open a PR

Run the same checks CI runs:

```bash
pnpm lint
pnpm typecheck
pnpm test
pnpm build
```

All must pass. PRs are gated on CI.

## Conventions

- Commits follow [Conventional Commits](https://www.conventionalcommits.org)
  (`feat:`, `fix:`, `chore:`, `refactor:`, `docs:`, `test:`, `perf:`).
- Match the style of the surrounding code — naming, comment density, and idiom.
- `dev` and `stable` profiles keep separate durable state; see the README for how
  that works before touching anything under `src/main/db`.

## Reporting bugs

Open an issue with what you did, what you expected, and what happened. Include
your macOS version and the `[arc] profile=… db=…` line printed at startup.
