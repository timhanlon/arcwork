import { Layer, ManagedRuntime, References } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { ProviderRegistryLive } from "./services/ProviderRegistry.js"
import { PresetRegistryLive } from "./services/PresetRegistry.js"
import { WorkspaceServiceLive } from "./services/WorkspaceService.js"
import { WorkspaceFilesServiceLive } from "./services/WorkspaceFilesService.js"
import { GitServiceLive } from "./services/GitService.js"
import { ChatServiceLive } from "./services/ChatService.js"
import { HookSignalServerLive } from "./services/HookSignalServer.js"
import { ActivityEventServiceLive } from "./services/ActivityEventService.js"
import { ChatMessageServiceLive } from "./services/ChatMessageService.js"
import { LiveTargetStateServiceLive } from "./services/LiveTargetStateService.js"
import { LocalModelServiceLive } from "./services/LocalModelService.js"
import { RawHookSignalServiceLive } from "./services/RawHookSignalService.js"
import { ArtifactIngestServiceLive } from "./services/ArtifactIngestService.js"
import { TargetSessionManagerLive } from "./services/TargetSessionManager.js"
import { ArcStoreLive } from "./db/store.js"
import { sqliteLayer } from "./db/sqlite.js"
import { arcDbPath } from "./db/paths.js"
import { IngestStoreLive } from "./ingest/db/store.js"
import { WorkStoreLive } from "./work/store.js"
import { WorkServiceLive } from "./work/service.js"
import { ReadServiceLive } from "./read/service.js"
import { ArcMcpServerLive } from "./mcp/server.js"
import { ArcRpcServerLive } from "./rpc.js"
import { Lensflare } from "./observability/lensflare.js"

// Persistence substrate. `Layer.suspend` defers `arcDbPath()` to build time —
// index.ts pins the profile/userData at boot before this runtime is first run,
// so resolution must not happen at import time.
//
// Keep these as shared constants: Effect memoizes layers by reference, so every
// service below observes the same SqliteClient, ArcStore, IngestStore, and
// WorkStore instances.
const SqliteLive = Layer.suspend(() => sqliteLayer(arcDbPath()))
const StoreLive = ArcStoreLive.pipe(Layer.provide(SqliteLive))
const IngestStoreLiveLayer = IngestStoreLive.pipe(Layer.provide(SqliteLive))
const WorkStoreLiveLayer = WorkStoreLive.pipe(Layer.provide(SqliteLive))
const WorkLive = WorkServiceLive.pipe(Layer.provide(Layer.mergeAll(WorkStoreLiveLayer, StoreLive)))

const PersistenceLayers = [StoreLive, IngestStoreLiveLayer, WorkStoreLiveLayer] as const

// Static registries and small local facades that do not depend on durable state.
const RegistryLayers = [ProviderRegistryLive, PresetRegistryLive, LocalModelServiceLive] as const

// Core domain services. These are intentionally built from the persistence and
// registry constants above so shared in-memory projections and the session
// manager are not duplicated by later RPC/MCP/controller wiring.
const RawHookSignalsLive = RawHookSignalServiceLive.pipe(Layer.provide(StoreLive))
const ActivityEventsLive = ActivityEventServiceLive.pipe(Layer.provide(StoreLive))
const WorkspacesLive = WorkspaceServiceLive.pipe(Layer.provide(StoreLive))
const WorkspaceFilesLive = WorkspaceFilesServiceLive.pipe(Layer.provide(WorkspacesLive))
const GitLive = GitServiceLive.pipe(Layer.provide(WorkspacesLive))
const ChatsLive = ChatServiceLive.pipe(Layer.provide(StoreLive))
const SessionsLive = TargetSessionManagerLive.pipe(
  Layer.provide(ProviderRegistryLive),
  Layer.provide(WorkspacesLive),
  Layer.provide(ChatsLive),
  Layer.provide(HookSignalServerLive),
  Layer.provide(StoreLive),
)

const ChatMessagesLive = ChatMessageServiceLive.pipe(
  Layer.provide(StoreLive),
  Layer.provide(IngestStoreLiveLayer),
  Layer.provide(SessionsLive),
  Layer.provide(ChatsLive),
  Layer.provide(LocalModelServiceLive),
  Layer.provide(ActivityEventsLive),
)
// The ephemeral live-activity projection over the session list + pending
// requests + hook turn lifecycle. Pure read model — it shares the one
// TargetSessionManager / ChatMessageService instance (memoized by reference).
const LiveTargetStatesLive = LiveTargetStateServiceLive.pipe(
  Layer.provide(SessionsLive),
  Layer.provide(ChatMessagesLive),
)

const DomainServiceLayers = [
  WorkLive,
  WorkspacesLive,
  WorkspaceFilesLive,
  GitLive,
  ChatsLive,
  HookSignalServerLive,
  RawHookSignalsLive,
  ActivityEventsLive,
  ChatMessagesLive,
  LiveTargetStatesLive,
  SessionsLive,
] as const

// Read and ingest surfaces sit above the domain services. `ReadLive` also uses
// the shared SqliteClient directly for indexed search, so it must receive the
// same `SqliteLive` reference as the stores.
const ReadLive = ReadServiceLive.pipe(
  Layer.provide(WorkLive),
  Layer.provide(ChatsLive),
  Layer.provide(ChatMessagesLive),
  Layer.provide(StoreLive),
  Layer.provide(SqliteLive),
)
const ArtifactIngestLive = ArtifactIngestServiceLive.pipe(
  Layer.provide(IngestStoreLiveLayer),
  Layer.provide(ChatMessagesLive),
  Layer.provide(ActivityEventsLive),
  Layer.provide(StoreLive),
  Layer.provide(NodeFileSystem.layer),
  Layer.provide(NodePath.layer),
)

const IngestAndReadLayers = [ReadLive, ArtifactIngestLive] as const

/** Composed services for the main process. */
export const AppLive = Layer.mergeAll(
  ...PersistenceLayers,
  ...RegistryLayers,
  ...DomainServiceLayers,
  ...IngestAndReadLayers,
)

/**
 * The renderer<->main RPC server, started as part of the runtime. Providing
 * `AppLive` here (the same reference Effect memoizes above) means the RPC
 * handlers share the one set of domain-service instances — one DB connection,
 * one session manager — with the controller and the reactive broadcasts.
 * Building the runtime starts the server's receive loop and registers its
 * `ipcMain` listener; runtime dispose tears both down.
 */
const RpcServerLive = ArcRpcServerLive.pipe(Layer.provide(AppLive))

/**
 * The in-process Arc MCP server (loopback HTTP), started as part of the runtime.
 * Providing `AppLive` here (the memoized reference) means its tools — work graph
 * verbs and the handoff verb — run against the same live service instances as the
 * UI and RPC handlers: one DB connection, one TargetSessionManager. Building the
 * runtime brings up the HTTP listener and writes the discovery file; dispose
 * tears it down. Binds this profile's persistent port (stable→7793, dev→7794) by
 * default so installed client configs stay valid across restarts and the two
 * profiles never fight over one port; if it's busy it skips (no silent ephemeral
 * fallback) — override with ARC_MCP_PORT, or ARC_MCP_ALLOW_EPHEMERAL=1.
 */
const McpServerLive = ArcMcpServerLive.pipe(Layer.provide(AppLive))

const RuntimeSurfaceLayers = [RpcServerLive, McpServerLive] as const

/**
 * In dev, drop the log floor to Debug so the per-request `rpc.server.*` traces
 * and `Effect.logDebug` lines are visible in the terminal; stable keeps the Info
 * default. `ARC_PROFILE` is stamped before the runtime is first built.
 */
const ObservabilityLive = Layer.succeed(
  References.MinimumLogLevel,
  process.env["ARC_PROFILE"] === "dev" ? "Debug" : "Info",
)

/**
 * Vendored Lensflare (see observability/lensflare.ts): an OTLP logger + tracer
 * that exports this process's effect logs/spans to a local Lensflare server
 * (default http://127.0.0.1:43110) for inspection. Dev enables it by default
 * unless LENSFLARE_ENABLED/LENSFLARE_DEV opt out; stable is opt-in only via
 * those env vars. LENSFLARE_ORIGIN repoints the server. When that server isn't
 * running the exporter self-disables in 60s windows (drops its buffer, no POSTs,
 * logs only at Debug), so this is silent and near-free when Lensflare is down.
 * `mergeWithExisting` keeps the terminal logger alongside the OTLP export. Note:
 * log capture honors the MinimumLogLevel floor above (Info in stable), so stable
 * ships Info+ logs plus all spans when explicitly enabled; spans aren't
 * level-gated.
 */
const LensflareLive = Lensflare.layer("arc", {
  enabled:
    process.env["ARC_PROFILE"] === "dev"
      ? Lensflare.isEnabled({ environment: "development" })
      : Lensflare.isEnabled({ environment: "production" }),
  serviceName: "arc",
})

const ObservabilityLayers = [ObservabilityLive, LensflareLive] as const

/**
 * One long-lived runtime for the main process. Built once at startup; every
 * IPC call runs an effect through it via `runtime.runPromise(...)`. The merged
 * `RpcServerLive` brings up the RPC server on first use (boot — see index.ts).
 *
 * Observability is `provideMerge`d UNDER the app layers, not merged as a sibling.
 * A sibling only reaches the runtime's root fiber (the controller's injected
 * `runFork`), so logs/spans from fibers forked *during* layer construction —
 * the TargetSessionManager queue consumers — and from RPC/MCP handler fibers ran
 * without the OTLP logger or tracer in scope and never reached Lensflare (that's
 * why `arc.target.first_output`, the `arc.target.launch` span, and Info-level
 * "target launched"/"target exited" lines were invisible while controller-driven
 * SQL spans and `arc.pty.dropped` exported fine). `provideMerge` makes the OTLP
 * logger + tracer + the `MinimumLogLevel` floor part of the context those layers
 * are BUILT in, while still merging them into the output so the root `runFork`
 * keeps them too.
 */
export const runtime = ManagedRuntime.make(
  Layer.mergeAll(AppLive, ...RuntimeSurfaceLayers).pipe(
    Layer.provideMerge(Layer.mergeAll(...ObservabilityLayers)),
  ),
)
