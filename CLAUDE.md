# Arc Work

Single Electron app (Effect v4 main + React renderer + typed Rpc seam). Source
lives at the repo-root `src/` — `src/main`, `src/renderer`, `src/shared` (no
package nesting; the monorepo was collapsed into this one app).

## Writing Effect — read the vendored docs first

Effect is pinned at `4.0.0-beta.74` (v4, **not** the v3 API most training data
knows). Before writing or reviewing any Effect code, read the canonical,
Effect-team-authored guidance vendored at **`docs/effect/`** — it's in the repo
(every worktree), so don't reach for a `.tmp/` clone. Start with
`docs/effect/patterns/effect.md` and `docs/effect/LLMS.md`; `docs/effect/ai-docs/`
has runnable per-topic examples; `docs/effect/MIGRATION.md` covers v3→v4 renames.

`docs/effect-idiom-audit.md` is the companion: anti-patterns mined from our own
history (e.g. `JSON.parse(x) as T` instead of `Schema.decode*`, `try/catch`
around a throwing decoder, v3 API names) — consult it to avoid known smells.

## Renderer layout — folder = Storybook section

`src/renderer/src/` is organized so **each folder maps to exactly one Storybook
`meta.title` section**. When you add a component, its folder is decided by the
section its story belongs to:

- `ui/` — generic, domain-free primitives (`Components /` stories: Button, Chip,
  Kbd, Select, …). Nothing in here may import app/domain types.
- `chat/` — `Chat /` (ChatWork, Message, ToolCall, the `*-tool-body` factories,
  composer under `chat/composer/`, chat hooks/display helpers).
- `sidebar/` — `Sidebar /` (rows, trees, `sidebar/workqueue/`).
- `work/` · `shell/` · `search/` · `terminal/` · `git/` — their feature.
- root holds **only** entry points + cross-cutting infra (`main.tsx`, `App.tsx`,
  `bridge.ts`, `rpc-client.ts`, `atoms.ts`, `*.d.ts`) — not a junk drawer.

Co-locate each component with its `.stories.tsx` and its own helpers.

Filename convention: **PascalCase = single-component module** (`WorkRow.tsx`);
**kebab/camel = everything else** — hooks (`useChatWork.ts`), JSX-factory helpers
(`arc-tool-body.tsx`), display maps (`work-status-display.ts`). The kebab `.tsx`
files are deliberate: they export factory functions, not a component.

## Code search — reach for the cheap tool first

Default to running search **in the main loop**. Do **not** delegate a lookup to the
Explore subagent — it pays cold-start + a multi-round agentic loop to replace a
sub-100ms shell command. Explore is only worth it for genuine multi-file fan-out
where you want the conclusion, not the file dumps.

Escalation order:

1. **`rg`** (ripgrep) — literal / regex / "where does X live". Fastest. The default.
   - `rg -t ts foo` · `rg -A3 -B1 foo` · `rg --pcre2 '(?<!\.)foo'`
   - rg's `-t ts` already covers `.tsx` (`*.cts,*.mts,*.ts,*.tsx`); there is **no
     `tsx` rg type** — `rg -t tsx` errors. (`tsx` is an *ast-grep* `-l` language,
     not an rg `-t` type — don't cross the two flags.)
2. **`sg`** (ast-grep, installed) — *structural* matches regex can't express, and
   safe AST codemods. Pays parser warmup (~300ms cold) so don't use it for plain
   where-is. `-l <lang>` here is ast-grep's language (`tsx`, `ts`), not an rg type.
   Match a parse-tree shape with `$VAR` / `$$$LIST` metavars:
   - `sg -p 'useEffect($A, $B)' -l tsx src/renderer` — every effect
   - `sg -p 'event.code === $X' -l ts src/renderer` — structural ===, any spacing
   - `sg -p 'catch ($E) { }' -l ts src` — swallowed errors
   - rewrite: `sg -p '$X === undefined' -r '$X == null' -l ts src` — AST-safe,
     won't touch strings/comments like `sed` would
3. **ctags / LSP** — definition jumps + find-references (symbol-aware, cross-file:
   knows `foo` the symbol from `foo` the substring). Use for "who calls this".
4. **Explore subagent** — only for broad fan-out across many files.
