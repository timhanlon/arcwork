# Effect v4 idiom audit — mined from past conversations

Source: mined ~44 high-signal Claude Code transcripts in this repo's project history
(`~/.claude/projects/-Users-tim-dev-aux/`) for places where a non-idiomatic Effect v4
pattern was **called out and then fixed** — by a user one-liner ("this is NOT idiomatic
effect"), a codex `/review` note, a self-correction, or a before→after edit diff.

Effect pinned at `4.0.0-beta.74`. Reference repos the corrections were measured against:
`.tmp/effect-smol`, `.tmp/effect-solutions`.

Each entry: the smell, the idiomatic fix, how it surfaced, and the codification track:
- **[sg]** mechanically expressible → ast-grep rule (sketch given)
- **[skill]** needs dataflow/architecture judgment → Effect-reviewer skill heuristic
- **[mem]** already a memory feedback file, or worth becoming one

---

## A. Error model & `Cause`

### A1. `cause instanceof Error ? cause.message : String(cause)` stringify helper — **[sg]+[mem]**
Hand-rolled normalization of an `unknown` cause to a string, then stored on the error.
Surfaced repeatedly (user: *"this is NOT idiomatic effect"*; reverted again later when a
review proposed *consolidating* the duplicate — which would "enshrine the smell").
**Fix:** put `cause: Schema.Defect` on the tagged error so the raw cause is preserved;
pretty-print only at the outer `Cause` boundary. Drop the helper.
- ast-grep: `$X instanceof Error ? $X.message : String($X)`
- **Caveat (important):** intentional and correct at never-throw boundaries — top-level
  CLI `main` catch, installer paths returning a result record, React error boundaries.
  Only a smell on/around an Effect tagged error or `Effect.catch*` handler. Rule message
  must say this; a blind rule over-fires (44 legit hits in one installer file).
- Already memory: `effect-error-causes`.

### A2. Plain `class X extends Error { readonly _tag = "X" }` — **[sg]**
Hand-rolled `_tag` on a raw `Error` forces `instanceof` matching at the RPC seam and skips
structural equality / `Cause` rendering.
**Fix:** `class X extends Data.TaggedError("X")<{ readonly message: string }> {}` — still a
real `Error`, gains `_tag` matching, `catchTag`, structural equality. Use
`Schema.TaggedError` only for errors that cross the wire.
- ast-grep: `class $N extends Error { $$$ }` containing a literal `_tag` member.

### A3. `instanceof ArcRequestError` matching → `catchTag` / `_tag` (follows from A2). **[skill]**

---

## B. Promise / fiber boundary (the biggest cluster)

### B1. `.catch(e => console.error(e))` on a fire-and-forget `rpc(...)` / `void rpc().then()` — **[sg]+[skill]**
A detached promise escapes the fiber, so failures never reach the Effect log/trace seam
(Lensflare). Bolting a reporter onto `.catch` was explicitly rejected ("keeping the exact
anti-pattern"; user: *"WHY ARE WE CATCHING!"*).
**Fix:** keep the whole call inside one Effect; `runFork` it and fold failure into
`Effect.logError` via `Effect.catchCause`. Note bare `runFork` does **not** auto-report —
only `Runtime.runFork` / `FiberSet.makeRuntime()` wrap with `tapCause`. Centralized as
`runRendererCommand(context, effect)`.
- ast-grep: `$P.catch(($E) => console.error($$$))` and `void $RPC(...).then($$$)`

### B2. `useState`/`useEffect`/`.then`/`setError` triad for server state — **[skill]**
Async RPC hand-threaded through loading/error/data `useState` + `useEffect` fetch.
**Fix:** model each RPC/stream as an `Atom` producing `AsyncResult`; read via `useAtomValue`
+ `AsyncResult.match`; write via `useAtomSet(atom, { mode: "promiseExit" })` (returns per-call
`Exit`, never rejects, and writes into the atom's `AsyncResult`). `useAtomRefresh` to refresh.
- Heuristic: `useState` loading/error/data triad next to a `useEffect` that calls `rpc(...)`.

### B3. `Effect.promise(() => rpcThatRejects())` — **[sg]**
`Effect.promise` turns a rejection into a **defect**, not a typed failure.
**Fix:** `Effect.tryPromise(...)` when the promise can reject.
- ast-grep: flag `Effect.promise($A)` as a candidate.
- **Caveat:** the reverse is also idiomatic — `Effect.promise(async () => { try…catch…return fallback })`
  where the closure handles its own failures and `E = never`. Not a safe auto-fix; advisory only.

---

## C. v3 → v4 API renames (clean codemods, high value)

### C1. `Effect.fork` → `Effect.forkChild` — **[sg]+[mem]**
`Effect.fork` does not exist in beta.74; throws at the continuation boundary.
- ast-grep fix: `Effect.fork($X)` → `Effect.forkChild($X)`. Also `forkScoped`/`forkIn` exist.

### C2. `Effect.forkDaemon` → `Effect.forkDetach` — **[sg]+[mem]**
- ast-grep fix: `Effect.forkDaemon($A)` → `Effect.forkDetach($A)`.

### C3. `Effect.either` → `Effect.result` — **[sg]+[mem]**
v4 uses `Result` not `Either`: `Effect.result` returning `Result`, branch on `_tag === "Failure"`
with `.success` / `.failure` (not `Left`/`Right`/`.left`/`.right`).
- ast-grep: `Effect.either` (fix → `Effect.result`); follow-ups `$X._tag === "Left"`, `.left`, `.right`.

---

## D. Schema usage

### D1. `try { Schema.decodeUnknownSync($S)($X) } catch { return null }` — **[sg]**
Custom throwing-decoder-in-try/catch (user: *"wrestling typescript to build a helper … isn't
what we want"*; a codex review also flagged a `decodeUnknownSync`-in-try/catch as "off-grain").
**Fix:** built-in non-throwing decoder — `Schema.decodeUnknownOption` (→ `Option`) or
`decodeUnknownEither`, or `Schema.decodeUnknown` + `Effect.either` in an Effect context.
- ast-grep: `try { $$$ $X.decodeUnknownSync($S)($R) $$$ } catch { $$$ }` (also `decodeSync`).

### D2. `Schema.Schema<A, any>` as a generic bound — **[sg]**
`any` in the encoded slot collapses inference.
**Fix:** `<S extends Schema.Top>(schema: S) => …: S["Type"]`.
- ast-grep: `Schema.Schema<$A, any>`.

### D3. `Schema.String` for a closed enum, re-validated downstream — **[skill]**
Wire field typed `Schema.String` for a finite domain forces a renderer `toState(): T | null`
re-validator + `Record<T,…>` lookups guarded with `!`.
**Fix:** `Schema.Literal("open","merged","closed")` at the wire boundary → lookups become total,
the null re-validator + `!` + IIFE vanish.
- Heuristic: a `Record<Union, X>` lookup needing `!` ⇒ the wire type should be `Schema.Literal`.

### D4. `JSON.parse(x) as unknown` + hand-rolled type guards — **[sg]**
In a codebase that has Effect `Schema`.
**Fix:** `Schema.Array(Schema.Struct({…}))` + decode.
- ast-grep: `JSON.parse($X) as unknown` followed by `Array.isArray` / `typeof … === "object"` chains.

### D5. Unconstrained `Flag.string("format")` validated inside the handler body — **[skill]**
Literal-set check runs at runtime in the `Effect.gen` body.
**Fix:** map the flag through `Schema.Literal("text","json")` at parse time.
- Dataflow-dependent; reviewer-heuristic, not a clean ast-grep target.

---

## E. Layers, services, requirements

### E1. `Layer.succeed(S, S.of({ … yield* OtherService … }))` — **[sg]+[skill]**
A layer whose method bodies need another service, but `Layer.succeed` gives nowhere to
`yield*` it, so the dependency silently leaks into callers (often masked by an `unknown` R).
**Fix:** `Layer.effect(S, Effect.gen(function*(){ const dep = yield* OtherService; return S.of({…}) }))`.
- ast-grep: `Layer.succeed($SVC, $SVC.of($OBJ))` where `$OBJ` body `yield*`s a service.

### E2. Service method R channel typed `unknown` (or `any`) — **[sg]**
`Effect.Effect<X, E, unknown>` / `…, any>` on methods collapses inference so `Effect.provide`
can't subtract requirements to `never` — leaked deps go unnoticed.
**Fix:** `Effect.Effect<X, E, never>` for self-contained methods; fix the real signature instead
of widening.
- ast-grep: `Effect.Effect<$A, $E, unknown>` and `Effect.Effect<$A, $E, any>` in service/test code.

### E3. `as any` test wrapper to silence `it.effect` requirement errors — **[sg]**
`forItEffect = <A,E,R>(self): Effect.Effect<A,E,any> => self` — "`as any` in a trench coat";
hides a forgotten `Effect.provide`.
**Fix:** write `it.effect("…", () => Effect.gen(…).pipe(Effect.provide(Live)))` directly so R is `never`.
- ast-grep: a function returning `Effect.Effect<$A, $E, any>`.

### E4. Resource-owning service via `Layer.effect` + `Effect.sync` with no `acquireRelease` — **[skill]**
Every socket / timer / fiber / child process needs a finalizer.
**Fix:** `Layer.scoped` + `Effect.acquireRelease`.

### E5. Leaf factory baking `Effect.provide(NodeServices.layer)` — **[sg]**
Platform layers provided deep in a leaf hide real requirements.
**Fix:** keep requirements honest; provide platform layers only at the composition root.
- ast-grep: `Effect.provide(NodeServices.layer)` (and similar platform layers) outside the root.

### E6. Background/init work as a free-floating fork instead of a Layer — **[skill]**
**Fix:** `Layer.effectDiscard(Effect.gen(…))`; loops via `Effect.forkScoped({ startImmediately: true })`.

---

## F. Concurrency & resource lifetime

### F1. Orphaned `runtime.runFork(Stream.runForEach(…))` module-level subscriptions — **[sg]+[skill]**
Subscriptions that leak forever, never interrupted.
**Fix:** run inside a scoped controller and `.pipe(Effect.forkScoped)`; controller under
`Scope.makeUnsafe()` + `Scope.provide`, disposed on quit.
- ast-grep: `runtime.runFork(Stream.runForEach($$$))`.

### F2. `setInterval(() => runtime.runFork(…))` for recurring work — **[skill]**
Leaks across sessions, no finalizer.
**Fix:** per-key `FiberMap` (`FiberMap.make/run/remove`) of interruptible scoped fibers.

### F3. Raw `emitter.on(…)` / IPC callback / `pty.spawn` with no finalizer — **[skill]**
**Fix:** `Stream.callback` + `Effect.acquireRelease` / `Effect.addFinalizer(() => emitter.off(…))`.

### F4. `Effect.runSync` / `runFork` fired from inside a sync callback (`emitter.on`, pty `onExit`) — **[sg]+[skill]**
Fiber escape — work runs outside the runtime/logger/scope.
**Fix:** push onto a `Queue` / `Stream` consumed by one supervised scoped fiber.
- ast-grep candidate: `Effect.run*(` inside a `$E.on(…, () => { … })` callback.

### F5. Bare `runFork` escaping the layer's logger & scope — **[skill]**
**Fix:** `const runFork = yield* FiberSet.makeRuntime()` inside the layer (inherits logger,
interrupted on scope close). Use `Runtime.runFork`, not bare `Effect.runFork`, where reporting matters.

### F6. Plain `Ref` (often + a separate `EventEmitter`) for state that must be observed — **[skill]+[mem]**
**Fix:** `SubscriptionRef.make(…)` — `.changes` is a `Stream` (current value then every update);
expose as a streaming RPC, mirror to a renderer atom.

### F7. `let` mutated across nested `Effect.gen` — **[skill]**
**Fix:** `Ref`. (Surfaced as a non-blocking review note.)

---

## G. RPC handler shape

### G1. `try { runPromise(…) } catch { console.warn; throw }` in an RPC handler — **[skill]**
Collapses the typed error channel.
**Fix:** `runPromiseExit` + `Exit.isSuccess` branch; `Cause.squash` / `Cause.pretty`; return a typed
envelope `{ ok:true, value } | { ok:false, error:{ _tag, … } }`. The `any` lives only at that one
dynamic dispatch boundary; target is `@effect/rpc`.

---

## H. Observability (mostly already enforced)

### H1. `console.*` for failure/signal logging — **[sg, already enforced by oxlint]+[mem]**
oxlint `eslint/no-console: error` already bans this (overrides: `scripts/**`, `smoke/**`,
`*.stories.tsx`, `*.test.*`, `*.mjs`).
**Fix:** `Effect.logWarning/Error(…)` inside `Effect.withSpan("rpc.server.<tag>", { attributes })`;
level via `Layer.succeed(References.MinimumLogLevel, …)`. Explicitly **not** `withLogSpan`.
- Memory: `observe-via-effect-not-console`.

### H2. Observability layer merged as a sibling instead of `provideMerge`d under app layers — **[skill]+[mem]**
A sibling in `Layer.mergeAll(App, …, Observability)` only reaches the root fiber; handler/forked
fibers run without the OTLP logger/tracer + `MinimumLogLevel` floor.
**Fix:** `Layer.mergeAll(App, RpcServer, McpServer).pipe(Layer.provideMerge(Layer.mergeAll(Observability, Lensflare)))`.
- Memory: `lensflare-observability-fiber-scope`.

---

## I. Time

### I1. `new Date()` / `Date.now()` inside Effects — **[sg]**
Non-deterministic, not pinnable under `TestClock`.
**Fix:** `Clock` / `DateTime.now` (e.g. `Effect.map(DateTime.now, DateTime.formatIso)` in `clock.ts`).
- ast-grep: `Date.now()` / `new Date()` inside `Effect.gen` / `Effect.fn` bodies (allowlist hooks/smoke).

---

## J. Misc (Effect-adjacent)

### J1. `Effect.sync(() => { try…catch… })` then `Effect.as(x)` + `Effect.catchAll(…)` — **[sg]**
**Fix:** `Effect.try(() => …)` to capture the reason, then `Effect.match({ onSuccess, onFailure })`
to fold both channels in one step.
- ast-grep: `Effect.sync(() => { $$$ try { $$$ } catch ($E) { $$$ } })`; and `Effect.as($X)` immediately piped into `Effect.catchAll(…)`.

### J2. Mutating `process.env` + `node:fs` to forward env to children — **[sg]+[skill]**
**Fix:** a `Dotenv` service on `@effect/platform` `FileSystem` + `Path`; merge into
`ChildProcess.make(…, { env, extendEnv: true })`. Never mutate `process.env`.
- ast-grep: `process.env.$K = $V` and `node:fs` imports inside `src/main/services/**`.

### J3. Multi-statement SQL write not wrapped in a transaction — **[skill]**
**Fix:** `sql.withTransaction(Effect.gen(…))`.

### J4. Per-site catch-and-ignore instead of a named `bestEffort` combinator — **[skill]**
**Fix:** a pipeable `bestEffort(label, fallback)` applied at the boundary.

---

## Codification summary

| Track | Count | Home |
|-------|-------|------|
| ast-grep rules | ~15 | new `sgconfig.yml` + `rules/effect/*.yml`, wired into `pnpm lint` + pre-commit |
| Effect-reviewer skill | ~18 | `.claude/skills/effect-review/SKILL.md` (the dataflow/lifetime/layer judgment calls) |
| Already enforced | 1 | oxlint `no-console` (H1) |
| Memory feedback | 4 existing + ~4 new | `effect-error-causes`, `observe-via-effect-not-console`, `lensflare-observability-fiber-scope`; new: C1–C3 renames, F6 SubscriptionRef, A2 Data.TaggedError |

**Cleanest ast-grep wins** (low false-positive, high value): C1/C2/C3 (v4 renames, auto-fixable),
D1 (decode-in-try/catch), D2 (`Schema.Schema<_, any>`), E1 (`Layer.succeed` that yields), E2/E3
(widened R), F1 (orphaned stream fork), J1 (`Effect.try`+`match`).

**Needs the scoping caveat or it over-fires:** A1 (`instanceof Error ? …`), B3 (`Effect.promise`),
I1 (`Date.now` — allowlist hooks/smoke). These are better as warnings or skill heuristics.
