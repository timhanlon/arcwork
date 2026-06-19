import { Effect, type FileSystem, Layer, type Path } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import { IngestStoreLive } from "./db/store.js"
import { sqliteLayer } from "./db/sqlite.js"
import { makeClaudeProvider } from "./providers/claude.js"
import { makeCodexProvider } from "./providers/codex.js"
import { makeCursorProvider } from "./providers/cursor.js"
import type { AgentProvider } from "./providers/provider.js"

/** Build the three providers (each captures FileSystem/Path once). */
export const makeProviders: Effect.Effect<
  ReadonlyArray<AgentProvider>,
  never,
  FileSystem.FileSystem | Path.Path
> = Effect.all([makeClaudeProvider, makeCodexProvider, makeCursorProvider])

/**
 * Composition root: the IngestStore (over a SqliteClient pointed at `dbPath`)
 * plus the platform services (FileSystem/Path) the providers need.
 */
export const appLayer = (dbPath: string) =>
  Layer.mergeAll(
    IngestStoreLive.pipe(Layer.provide(sqliteLayer(dbPath))),
    NodeFileSystem.layer,
    NodePath.layer,
  )
