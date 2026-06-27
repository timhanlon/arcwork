import { Effect } from "effect"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import type { TargetSession } from "../../../shared/instance.js"
import { arcMcpBearerToken } from "../../../shared/env-tags.js"
import { cursorPluginLaunchArgs, installCursorHooks, installCursorPlugin } from "../../hooks/cursor-plugin.js"
import { installPiExtension, piLaunchArgs } from "../../hooks/pi-connector.js"
import { isMcpProvider, providerMcpLaunchArgs } from "../../mcp/client-config.js"
import { resolveProfile } from "../../db/paths.js"

/** The launch/resume context a provider needs to build its integration argv —
 * the ids that scope an Arc-owned plugin/MCP config and the cwd it runs in. */
export interface ProviderArgsContext {
  readonly chatId: string
  readonly targetSessionId: string
  readonly cwd: string
  readonly model?: string
}

/** Provider integration argv, shared by launch + resume. cursor writes its
 * Arc-owned plugin dir and loads it via `--plugin-dir`; claude/codex declare
 * the arc MCP server inline. Best-effort: a failed cursor plugin write logs
 * and falls through to no extra args rather than blocking the spawn. */
export const buildProviderArgs = (
  provider: string,
  ctx: ProviderArgsContext,
): Effect.Effect<Array<string>> =>
  Effect.gen(function* () {
    // Resolve the profile once here (the main process has ARC_PROFILE pinned at
    // boot) and thread it into the MCP config so a dev-launched session targets
    // :7794 and a stable one :7793 — its writes land in the launching app's DB.
    const profile = resolveProfile()
    if (provider === "cursor") {
      // Per-session plugin dir carrying a literal bearer: Cursor won't expand
      // ${env:…} in MCP headers, so the token is baked in by session id here.
      const plugin = installCursorPlugin({
        scopeId: ctx.targetSessionId,
        bearerToken: arcMcpBearerToken(ctx),
      })
      if (!plugin.installed) {
        yield* Effect.logWarning(`cursor plugin install failed: ${plugin.reason ?? "unknown error"}`)
        return []
      }
      // Lifecycle hooks must live in the workspace's .cursor/hooks.json —
      // cursor-agent ignores the plugin's bundled hooks (it only loads the
      // plugin's MCP). Without this the native session never binds and the
      // transcript never ingests.
      const hooks = installCursorHooks(ctx.cwd)
      if (!hooks.installed) {
        yield* Effect.logWarning(`cursor hooks install failed: ${hooks.reason ?? "unknown error"}`)
      }
      return [...cursorPluginLaunchArgs(plugin.dir, profile)]
    }
    if (provider === "pi") {
      // pi gets the arc toolkit + hook relay from a self-registering extension
      // (`-e`); identity/endpoint ride the env arcEnvTags already injects.
      const ext = installPiExtension()
      if (!ext.installed) {
        yield* Effect.logWarning(`pi extension install failed: ${ext.reason ?? "unknown error"}`)
        return []
      }
      return [...piLaunchArgs(ext.file, ctx.model)]
    }
    return isMcpProvider(provider) ? [...providerMcpLaunchArgs(provider, profile)] : []
  })

export const resumeArgs = (provider: string, nativeSessionId: string | undefined): Array<string> | null => {
  if (!nativeSessionId) return null
  switch (provider) {
    case "claude":
      return ["--resume", nativeSessionId]
    case "codex":
      return ["resume", nativeSessionId]
    case "cursor":
      return ["--resume", nativeSessionId]
    case "pi":
      // pi resolves a (partial/full) session UUID within the cwd's session dir.
      return ["--session", nativeSessionId]
    default:
      return null
  }
}

const claudeProjectSlug = (cwd: string): string => cwd.replaceAll("/", "-").replaceAll(".", "-")

export const inferredTranscriptPath = (s: TargetSession): string | undefined => {
  if (!s.nativeSessionId) return undefined
  if (s.nativeTranscriptPath) return s.nativeTranscriptPath
  if (s.provider === "claude") {
    return path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(s.cwd), `${s.nativeSessionId}.jsonl`)
  }
  return undefined
}

export const canResume = (s: TargetSession): boolean => {
  if (!s.nativeSessionId) return false
  const transcriptPath = inferredTranscriptPath(s)
  if (s.provider === "claude") return Boolean(transcriptPath && fs.existsSync(transcriptPath))
  return true
}
