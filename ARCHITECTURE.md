# Architecture

Arc Work is a single Electron app for driving local agent CLIs — Claude Code, Codex,
Cursor — from one conversation workspace. It launches each CLI as a live
terminal child, instruments it so their turns, tool calls, and questions become
structured data, and gives them (and you) a shared surface for chats, work
items, reviews, search, and local workspace context.

This document describes how the pieces fit together. For the *why* behind
specific decisions, the source files carry detailed header comments — this is
the map, not the territory.

## Process topology

The app collapses into four source trees under `src/`, one per Electron process
boundary plus a shared contract layer:

| Tree | Process | Role |
| --- | --- | --- |
| `src/main` | Electron **main** (Node) | Effect runtime, persistence, PTY children, hook plane, ingest, MCP + RPC servers |
| `src/preload` | Electron **preload** | the `window.arc` bridge — the only IPC surface the renderer touches |
| `src/renderer` | Electron **renderer** (Chromium) | React UI, reactive atoms, XState shell, xterm terminals |
| `src/shared` | both | schemas and the typed RPC contract, imported by main and renderer alike |

The main process is an Effect v4 application. The renderer is a React 19 app.
The two communicate over a single typed RPC seam (control plane) plus a few raw
IPC channels for PTY bytes (data plane). There is no direct `ipcRenderer.invoke`
sprinkled through the UI — everything funnels through the bridge and the RPC
contract.

```
┌─────────────────────────────────────────────────────────────────┐
│ renderer (Chromium)                                               │
│   React + atoms (server state)  +  XState shell (local intent)    │
│         │  rpc()/AtomRpc            │  terminalRegistry (xterm)    │
└─────────┼──────────────────────────┼─────────────────────────────┘
          │ window.arc (preload bridge)                              
   control│plane (typed RPC)     data│plane (raw PTY bytes)         
┌─────────┼──────────────────────────┼─────────────────────────────┐
│ main (Node, Effect ManagedRuntime) ▼                              │
│   RpcServer ── domain services ── MCP server (loopback HTTP)      │
│        │            │                                             │
│        │      TargetSessionManager ── PTY children (node-pty)     │
│        │            │                      │ stdout    │ hooks    │
│        │      HookSignalServer ◀───────────┴───────────┘ (socket) │
│        ▼            ▼                                             │
│   SQLite (one file: arc store + ingest store + work graph)        │
└───────────────────────────────────────────────────────────────────┘
          ▲                                   ▲
   arc-mcp installs client config       agent CLIs call arc MCP
   (reads arc-mcp.json beside DB)        (loopback HTTP :7793)
```

## The Effect runtime and layer graph

Everything in main hangs off one long-lived `ManagedRuntime`, built once at
startup in `src/main/runtime.ts`. Every IPC call, hook signal, and background
fiber runs an effect through it via `runtime.runPromise(...)` / `runtime.runFork(...)`.

Services are wired as Effect **layers**, composed bottom-up:

- **Persistence substrate** — `SqliteLive` (`Layer.suspend(() => sqliteLayer(arcDbPath()))`,
  deferred to build time so the profile is pinned first) feeds three stores that
  all share the *same* `SqlClient` instance by reference: `ArcStoreLive` (domain),
  `IngestStoreLive` (transcript artifacts), `WorkStoreLive` (work graph).
- **Registries** — static facades with no durable state (`ProviderRegistry`,
  `PresetRegistry`, `LocalModelService`).
- **Domain services** — `ChatService`, `TargetSessionManager`, `ChatMessageService`,
  `ActivityEventService`, `RawHookSignalService`, `LiveTargetStateService`,
  `WorkspaceService`, `GitService`, `WorkService`, etc.
- **Read/ingest surfaces** — `ReadService` (unified search/get) and
  `ArtifactIngestService` sit above the domain services.
- **Runtime surfaces** — `ArcRpcServerLive` and `ArcMcpServerLive`, both given the
  same `AppLive` reference so the RPC handlers and MCP tools run against the
  *identical* live service instances as the controller and the reactive broadcasts.
  One DB connection, one session manager, one of everything.

Effect memoizes layers by reference, so wiring `AppLive` into multiple consumers
shares the instances rather than duplicating them — this is the load-bearing
invariant of the whole design (`runtime.ts` keeps the layer constants shared
deliberately for exactly this reason).

Observability (`LensflareLive` + a `MinimumLogLevel` floor) is `provideMerge`d
*under* the app layers, not merged as a sibling, so logs and spans from fibers
forked *during* layer construction (e.g. the session-manager queue consumers) and
from RPC/MCP handler fibers reach the OTLP exporter — see the long comment in
`runtime.ts`.

### Boot and shutdown

`src/main/index.ts` is the entry point. It:

1. Loads `.env` (no-override policy), then **pins the profile** before anything
   touches durable state: `setupProfile()` calls `app.setPath("userData", …)` so
   both the SQLite DB and the Chromium profile move into a per-profile directory.
2. On `app.whenReady`, acquires `launchArcMainController` into a dedicated
   `Scope`. The controller owns all long-lived orchestration.
3. Creates the BrowserWindow, pointing at the electron-vite dev URL or the built
   `index.html`.

On quit it closes the controller scope first (removes IPC handlers, interrupts
broadcast fibers, cancels pollers) then disposes the runtime (kills child PTYs,
closes hook sockets, releases the DB) — every finalizer runs deterministically.

### Profiles: dev vs stable

`pnpm dev` and the built/preview app keep **separate durable state** so a dev
crash or half-run migration can never touch the daily-driver database. The
profile (`dev` | `stable`) is resolved in `src/main/db/paths.ts`, which splits
state two ways:

- the **domain DB** is home-rooted — `~/.arcwork/<profile>/state/arc.sqlite`
  (`~/.arcwork/dev/…` vs `~/.arcwork/stable/…`) — kept outside Electron so CLI /
  MCP / shared-agent workflows can inspect, back up, and reset it trivially;
- **Electron profile data** (cache, cookies, window state) stays in `userData`,
  per-profile under one app dir (`~/Library/Application Support/Arc Work/<profile>`).
  The main process pins `app.setPath("userData", …)` to the matching dir so the
  two stay in lockstep; `paths.ts` itself is Electron-free so `arc-mcp` (plain
  Node) resolves the same locations.

`ARC_PROFILE` is stamped into the environment so child sessions (and the `arc-mcp`
CLI they launch) inherit it and resolve the same DB file. `ARC_DB_PATH` overrides
the DB outright for scratch/testing. See the README for the full table.

## The RPC seam

The typed main↔renderer contract is defined **once** in `src/shared/rpc.ts` as an
`effect/unstable/rpc` `RpcGroup` (`ArcRpcs`). Each `Rpc.make` carries its own
payload, success, and error schema. From that single source:

- the renderer client type is derived,
- the main handler table (`src/main/rpc.ts`) is type-checked against it (a missing
  or mis-shaped handler is a compile error),
- the on-the-wire encoding is generated.

There is no parallel request union or response-schema map to keep in lockstep.
Adding a door onto a service is one `Rpc.make` entry plus one handler.

**Transport** (`src/main/rpc-transport.ts`, `src/renderer/src/rpc-client.ts`):
a real Effect RPC client/server pair over Electron IPC. Encoded client messages
go renderer→main on `arc:rpc` (`ipcRenderer.send`); encoded server replies go
main→renderer on `arc:rpc-reply` (`webContents.send`). Because the messages are
already past the schema-encode boundary they're structured-clone-safe and cross
IPC as-is — no NDJSON/MsgPack byte layer, no bespoke envelope.

A subtlety the transport handles: `RpcServer` keys per-client state by clientId,
and the renderer's request counter resets to zero on every page load. A
`WebContents` id is stable across reload, so the transport allocates a *fresh
logical clientId per renderer load* (retiring the old one on `did-start-loading`
/ `destroyed`) — otherwise a reloaded renderer would reuse request ids against
lingering state and hang. See the header comment in `rpc-transport.ts`.

**Two request shapes:**

- **Request/response** RPCs run through `rpcEffect` (`src/main/rpc.ts`), which
  wraps each call in an `rpc.server.<tag>` span and maps failures to a typed
  `RpcError`: an expected `ArcRequestError` surfaces verbatim; anything else is
  logged with its full cause and collapsed to a generic message so internals
  never leak across the seam.
- **Streaming** RPCs (`Watch*`) return a service's reactive `changes` stream
  directly. List streams (`WatchSessions`, `WatchChats`, `WatchWorkspaces`,
  `WatchLiveTargetStates`) are backed by `SubscriptionRef`s that replay the
  current value on subscribe, so a fresh client gets the snapshot then live
  updates with no separate boot push. Signal streams (`WatchChatMessageChanges`,
  `WatchChatActivityChanges`, `WatchWorkChanges`) carry tiny *that-something-changed*
  descriptors; the renderer re-pulls the affected list via its normal query.

## The data plane (PTY)

Terminal bytes do not go through RPC. The preload bridge (`src/preload/index.ts`)
exposes raw channels: `onPtyData` / `onPtyExit` subscriptions, `ptyWrite` /
`ptyResize` for keystrokes and resize, and `onAssistantStream` for ephemeral
live assistant tokens (Claude only — render-only, never persisted; the durable
bubble lands from the transcript). This stream sits in raw Node event-loop land
for throughput, with listeners registered and torn down by `ArcMainController`.

## Persistence

One SQLite file (`@effect/sql-sqlite-node`, backed by `better-sqlite3`, WAL mode)
hosts three logically separate stores that share the connection:

### Arc domain store (`src/main/db/`)

The durable mirror of arc's own domain: `workspaces`, `chats`, `target_sessions`
(keyed `(chat_id, provider)`, persisting `native_session_id` so a resume can
recover which native session a chat owned), `chat_messages` (the projected
transcript, upserted by dedup key), `raw_hook_signals` (append-only raw signal
log), and `activity_events` (append-only normalized facts). Migrations are a
versioned ledger run by `migrator.ts` (`src/main/db/schema.ts`).

### Full-text search (`search_document` + FTS5)

A denormalized `search_document` table plus a `search_document_fts` external-content
FTS5 index back the unified read surface. Triggers keep chats and chat messages
projected into it; the work-graph migrations project work refs in too. (Migration
`0005` switched the sync triggers to UPSERT to keep the FTS index strictly 1:1
with the table — the header comment in `schema.ts` documents the index-bloat bug
it fixed.)

### Ingest store (`src/main/ingest/db/`)

A deliberately domain-free store for raw transcript artifacts read off disk:
`sessions`, `messages`, `tool_calls`, `file_hints`, `diagnostics`. Re-ingest is
idempotent (`replaceSession` upserts the session and replaces its child rows in a
transaction; deterministic ids mean parser changes diff cleanly).

### Work graph (`src/main/work/`)

An append-only document graph (see [Work graph](#work-graph)).

## Live sessions and the hook plane

This is how a target CLI becomes structured, observable data. For the exact
per-provider hook map — every hook arc installs, the payload fields, and what it
derives — see [HOOKS.md](HOOKS.md).

### Launching a target

`TargetSessionManager` owns the PTY lifecycle — one logical session per
`(chat, provider)`, PTYs held in a scoped map. On `launch`:

1. **Arm the hook socket** before spawn — `HookSignalServer.ensureListening(cwd)`
   creates a per-workspace Unix socket (path is a short hash under `$TMPDIR`, since
   socket paths are length-capped on macOS).
2. **Install provider hooks** into the config the CLI reads
   (`.claude/settings.local.json`, `.codex/hooks.json`, `.cursor/hooks.json`),
   all pointing at the Arc-owned helper script (`arc-hook-signal.mjs`) under
   `~/.arcwork/<profile>/runtime/` — one copy per profile, never written into
   the workspace. Re-installing replaces Arc's prior hook block (matched by the
   helper filename) rather than appending.
3. **Spawn the PTY** with env tags (`ARC_TARGET_SESSION_ID`, `ARC_CHAT_ID`,
   `ARC_HOOK_SOCK`, `ARC_HOOK_HELPER`, `ARC_PROFILE`, …) and the renderer-measured grid size (Ink
   reads `stdout.columns` once at startup and can't reflow later).
4. **Attach** raw `onData`/`onExit` handlers — output is published as events the
   controller broadcasts to the renderer over `arc:pty-data`.

### Hooks back to arc

Each agent CLI fires lifecycle hooks (session start, prompt submit, tool use,
stop, …). The generated helper reads the hook's stdin, wraps it with the env tags
and a version, and writes one JSON line to the Unix socket. `HookSignalServer`
parses each line into a typed `HookSignal` (resolving the provider from the
transcript path, falling back to payload shape) and emits two events: a `signal`,
and — when both the native session id and arc's target id are present — a
`binding`.

`ArcMainController` is the orchestrator. It streams those events and:

- routes **bindings** to `TargetSessionManager.bindNative` (fills in the native
  session id, persists it),
- fans each **signal** into three best-effort projections — `RawHookSignalService`
  (audit log), `ActivityEventService` (normalized facts), `ChatMessageService`
  (transcript rows) — none of which can fail the upstream signal,
- notes turn-lifecycle edges into `LiveTargetStateService`,
- triggers artifact backfill / transcript reconciliation.

### Live activity state

`LiveTargetStateService` derives each session's activity — `generating` / `idle`
/ `waiting_for_input` / `waiting_for_approval` / `detached` / `exited` — from three
inputs merged together: PTY ownership (`attached`/`state`), pending requests
(questions vs. permission approvals), and an ephemeral open-turn set fed by the
hook turn-lifecycle markers. This is the single status source both the sidebar
and the composer read.

### Pending requests

A target can block on a question or a permission approval. These come from two
sources merged in `ChatMessageService.listPending`: durable rows in `chat_messages`
(role `request`) and an in-memory map of live permission requests not yet
answered. When a PTY detaches or exits, the manager supersedes the session's
pending requests so the sidebar stops flagging a dead session.

### Transcript watching

`ArcMainController` watches each attached session's native transcript file
(debounced on mtime/size) and triggers `ArtifactIngestService` to backfill — see
below. It uses `fs.watchFile`, not `fs.watch`, because a rename kills the latter.

## Artifact ingest and dual projection

The hook stream is live but lossy — it has the model and turn boundaries but not
`thinking` blocks or tool *results* (which aren't ready when the hook fires).
The **artifact path** fills that in by reading the CLI's own transcript files
off disk.

Each provider implements `AgentProvider.collect(workspace, nativeSessionId?)`
(`src/main/ingest/providers/`), parsing its native format into a common row shape:

- **Claude** — `~/.claude/projects/<ws>/<session>.jsonl`, a DAG flattened by
  timestamp with resumed-session merging.
- **Codex** — `~/.codex/sessions/<date>/<session>.jsonl`, a chronological event
  stream.
- **Cursor** — `~/.cursor/chats/<ws-hash>/<session>/store.db`, JSON blobs in
  SQLite, topologically sorted via a reference DAG.

A shared `SessionRowBuilder` accumulates messages and tool calls under a single
cross-table `ordinal` so interleaved display order is recoverable, pairs tool
calls with their results, derives file hints, and generates deterministic ids.
The `nativeSessionId` hint lets the transcript-watch path re-parse only the
changed session (re-parsing whole projects per turn pegged the main process).

`ArtifactIngestService` calls `collect`, writes to the ingest store, then projects
into arc `chat_messages` via `chat-message/artifact-projection.ts`. The two paths
(hook and artifact) **converge on the same table**, deduped by a content-hash key
scoped to target session + message identity: whichever lands first wins, and the
artifact path can *reconcile* a hook row in place (claim an optimistic composer
echo, relabel a programmatic prompt to `meta`, fill in thinking and tool results).
Re-ingesting never duplicates.

## Work graph

`src/main/work/` is an append-only, event-sourced document graph — arc's durable
substrate for proposals, plans, todos, bugs, and decisions.

Three primitives:

- **Immutable revision nodes** (`graph_node`) — content-addressed; one per
  authored revision. Carry title, body, labels, an authored-intent status
  fallback, actor, and execution provenance (harness + model). Never rewritten.
- **Mutable refs** (`graph_ref`, TypeID prefix `work_`) — durable identity for a
  work item, pointing at its current node. A `revise` moves the ref to a new node
  via **compare-and-swap** in a transaction (fails `WorkRefConflict` on drift).
- **Typed append-only edges** (`graph_edge`) — everything relational *and* every
  workflow fact. **Status and priority are edge events, not content**: an
  `updateStatus` appends a `status_set` edge (latest wins), it does *not* mint a
  new node. Edges also model links (blocks / depends_on / duplicates /
  resolved_by / implements), provenance (`created_in_session`), citations,
  delegation (`delegated_to`), and the `revises` version chain.

Comments (`work_comment`) are append-only annotations anchored to a specific
revision node (default) or the durable ref.

`WorkService` (`work/service.ts`) hosts the verbs — `create`, `revise`,
`updateStatus`, `updatePriority`, `link`, `addCitation`, `comment`, plus the
read projections (`listOpen`, `listAll`, `listForChat`, `search`, `get`,
`listComments`). It publishes a `WorkChange` on every real mutation (no-op edits
don't emit). Provenance is resolved from a trusted `sessionId` via `ArcStore`
lookups (chat, workspace, harness, latest model), overriding caller-supplied
values.

### Two doors, one store

Work is reachable two ways, both hitting the same in-process `WorkService` over
the same DB file:

- **RPC** (`source: "rpc"`) — the renderer work navigator.
- **MCP** (`source: "mcp"`) — agent CLIs via `arc.work.*` tools.

## MCP server and the unified read surface

`src/main/mcp/` runs an **in-process** Arc MCP server over loopback HTTP (stable
port `7793`, endpoint `POST /mcp`), writing a discovery file beside the domain DB
(`~/.arcwork/<profile>/state/arc-mcp.json`) on launch. It exposes four tools to
agent CLIs:

- `arc.search` — FTS-backed discovery over work / chat / message kinds.
- `arc.get` — batch hydration of refs (`work_…`, `chat_…`, `message_…`).
- `arc.work.create` / `arc.work.update` — the work-graph write verbs.

Because `ArcMcpServerLive` is given the same `AppLive` reference as the RPC
server, MCP tools and renderer RPC run against the *same* `WorkService` and
`ReadService` instances — MCP is just another transport, the domain verbs stay
transport-agnostic.

**Provenance** (`mcp/provenance.ts`): direct HTTP clients embed session/chat in
the `Authorization: Bearer` token; the per-session stdio proxy (used by clients
that need it) stamps `x-arc-*` headers. Handlers trust headers first, then fall
back to voluntary tool params. The auto launch path declares the `arc` server
repo-clean (`mcp/client-config.ts` `providerMcpLaunchArgs`): claude and codex
get it inline through argv (`--mcp-config '<json>'`, `-c mcp_servers.arc.*`),
writing nothing; cursor has no inline lever so it merges into home-global
`~/.cursor/mcp.json` (+ `--approve-mcps`). The explicit `arc-mcp <provider>
--write` CLI still writes a persistent repo/user config for hand-editing.

**Read surface** (`src/main/read/service.ts`, contract in `src/shared/read.ts`):
`ReadService` is a thin composition over `WorkService` / `ChatService` /
`ChatMessageService`, querying the `search_document` FTS table. It serves both
the renderer (`SearchArc` / `GetArc` RPCs) and MCP (`arc.search` / `arc.get`) —
one search implementation, two doors. Result headers stay rigid across kinds
(`{ref, kind, title, preview, updatedAt, score}`) so an agent reads any kind the
same way.

## Renderer

The React renderer splits state by nature:

- **Server state** lives in reactive **atoms** (`src/renderer/src/atoms.ts`),
  built on `@effect/atom-react` over the RPC client. Live lists
  (`workspacesAtom`, `chatsAtom`, `sessionsAtom`, `liveTargetStatesAtom`) are
  `runtime.atom(Stream)` wrappers over the `Watch*` server streams — the boot
  snapshot rides the stream, no separate push + pull. Query atoms
  (`chatMessagesAtom`, `chatWorkAtom`, …) pair a one-shot RPC with
  `Atom.makeRefreshOnSignal` driven by the tiny `Watch*Changes` signal streams,
  so a high-frequency change channel re-pulls a list rather than re-streaming it.
  React reads everything as an `AsyncResult` via `useAtomValue`.
- **Local shell intent** (selected chat, open terminal panes, which surface is in
  each region, detached-session focus) lives in an **XState machine**
  (`src/renderer/src/shell/arcShellMachine.ts`). Layout is modeled as three named
  regions (left / center / right), each holding a discriminated `Surface` kind so
  a region can't drift into an illegal state. One verb — `open(target, pane)` —
  moves a surface into a region; illegal pairs are ignored.

`App.tsx` is the surface: it reads the atoms, derives a view model from the shell
state, and renders the sidebar / center (chat or work) / right (terminal, git, or
work) panels.

**Terminals** are keep-alive and owned by a `terminalRegistry` *outside* the
React tree — each opened session has a persistent xterm + DOM host the registry
parks and reparents, so a pane survives a session switch or a right-surface
switch (terminal → git → terminal) without being torn down. Pane ids are stable
local TypeIDs so a pane survives `launch → bound` (its `sessionId` fills in) without
losing freshly-spawned output.

The preload bridge attaches a beat after the renderer mounts (and re-runs on
reload), so all mount-time bridge access routes through `bridge.ts`
(`waitForBridge` / `subscribeWhenReady`) rather than racing it.

## Observability

The main process vendors **Lensflare** (`src/main/observability/lensflare.ts`),
an OTLP logger + tracer that exports effect logs and spans to a local Lensflare
server. Dev enables it by default; stable is opt-in. When the server is down the
exporter self-disables in 60s windows (no POSTs, near-free). Because every RPC
and MCP call runs inside a span, each request is a trace, and `Effect.log*` lines
nest under it. Use `Effect.withSpan` / `Effect.log*` for instrumentation —
`console.log` never reaches Lensflare.

Dev also exposes the renderer over the Chrome DevTools Protocol (port `9222`,
gated on the electron-vite dev URL) so a Playwright driver can screenshot / drive
the live window (`scripts/probe.mjs`).

## Build and tooling

- **electron-vite** (`electron.vite.config.ts`) builds three targets — main,
  preload, renderer. The main build externalizes native modules (`node-pty`,
  `better-sqlite3`) and emits extra entrypoints: the `raw-hook-signal-smoke` test
  and the `cli-mcp` executable.
- **Native modules** are compiled against Electron's ABI on `pnpm install`;
  `pnpm rebuild` (`electron-rebuild`) fixes ABI mismatches.
- **Tailwind v4** is the renderer styling foundation; **Storybook** verifies
  components in isolation.
- **Tests** run under **Vitest** (`pnpm test`). DB tests alias `better-sqlite3` to
  a `node:sqlite` shim because the Electron-ABI build won't load under plain Node.
- **CI gate**: `pnpm typecheck`, `pnpm test`, `pnpm build` must all pass
  (see CONTRIBUTING.md).

## Where to start reading

| To understand… | Start at |
| --- | --- |
| Process boot, profiles, shutdown | `src/main/index.ts`, `src/main/db/paths.ts` |
| The service graph | `src/main/runtime.ts` |
| The RPC contract | `src/shared/rpc.ts`, `src/main/rpc.ts` |
| Live sessions + hooks | `src/main/services/TargetSessionManager.ts`, `ArcMainController.ts` |
| Transcript ingest | `src/main/ingest/`, `src/main/services/ArtifactIngestService.ts` |
| Work graph | `src/main/work/schema.ts`, `src/main/work/service.ts` |
| MCP + search | `src/main/mcp/server.ts`, `src/main/read/service.ts` |
| The UI | `src/renderer/src/App.tsx`, `atoms.ts`, `shell/arcShellMachine.ts` |
