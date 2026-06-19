/**
 * Tool classification now lives in the shared tool catalog
 * (`src/shared/tool-catalog.ts`) so the ingest classifier, the renderer
 * dispatch, and the Storybook fixtures all derive from one source. This module
 * re-exports it for the ingest call sites and keeps the cross-language sync
 * note: keep the JS catalog in sync with the native Swift classifier —
 * `ToolType` in arc/Sources/ArcCore/ExtractedModels.swift and
 * `PathHints.classifyToolType` in arc/Sources/ArcProviders/PathHints.swift.
 */
export { classifyTool, type ToolKind } from "../../../shared/tool-catalog.js"
