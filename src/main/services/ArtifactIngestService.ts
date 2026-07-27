import { Context, Effect, Layer } from "effect"
import type { ChatId } from "../../shared/ids.js"
import type { Provider } from "../ingest/db/schema.js"
import { IngestStore } from "../ingest/db/store.js"
import { makeProviders } from "../ingest/layers.js"
import type { CollectHint } from "../ingest/providers/provider.js"
import { ChatMessageService } from "./ChatMessageService.js"
import { ArcStore } from "../db/store.js"
import { bestEffort } from "./failure-policy.js"
import { ActivityEventService } from "./ActivityEventService.js"

export interface ProviderIngestSummary {
  readonly provider: Provider
  readonly sessions: number
  readonly messages: number
  readonly toolCalls: number
  readonly fileHints: number
  readonly diagnostics: number
  readonly skipped: number
}

type MutableProviderIngestSummary = { -readonly [K in keyof ProviderIngestSummary]: ProviderIngestSummary[K] }

export class ArtifactIngestService extends Context.Service<
  ArtifactIngestService,
  {
    readonly ingestWorkspace: (
      workspace: string,
      provider?: Provider | "all",
      /** What the caller already knows about the session it wants ingested (see
       * `CollectHint`). `nativeSessionId` scopes persistence to that one session,
       * avoiding ~N redundant rewrites on the common turn-end path;
       * `transcriptPath` is how a session whose cwd has drifted from its
       * transcript's location is found at all. */
      hint?: CollectHint,
    ) => Effect.Effect<ReadonlyArray<ProviderIngestSummary>, never>
    readonly reingestAndReprojectChat: (
      chatId: ChatId,
      provider?: Provider | "all",
    ) => Effect.Effect<{
      readonly ingest: ReadonlyArray<ProviderIngestSummary>
      readonly reproject: { readonly deleted: number; readonly inserted: number }
    }, never>
  }
>()("arcwork/ArtifactIngestService") {}

export const ArtifactIngestServiceLive = Layer.effect(
  ArtifactIngestService,
  Effect.gen(function* () {
    const store = yield* IngestStore
    const chat = yield* ChatMessageService
    const arc = yield* ArcStore
    const activity = yield* ActivityEventService
    const providers = yield* makeProviders

    const ingestWorkspace = (workspace: string, filter: Provider | "all" = "all", hint?: CollectHint) =>
      Effect.gen(function* () {
        const nativeSessionId = hint?.nativeSessionId
        const summaries: Array<ProviderIngestSummary> = []
        const selected = providers.filter((p) => filter === "all" || p.id === filter)

        for (const provider of selected) {
          const summary: MutableProviderIngestSummary = {
            provider: provider.id,
            sessions: 0,
            messages: 0,
            toolCalls: 0,
            fileHints: 0,
            diagnostics: 0,
            skipped: 0,
          }

          // One parse pass per provider (see AgentProvider.collect). The native
          // id is a hint: providers that can parse just that session (cursor) do;
          // others parse all and we filter below. Either way persist scopes to it.
          const collected = yield* Effect.result(
            provider.collect(workspace, hint).pipe(
              Effect.withSpan("arc.ingest.collect", {
                attributes: {
                  "arc.provider": provider.id,
                  "arc.workspace": workspace,
                  "arc.native_session_id": nativeSessionId ?? null,
                  "arc.transcript_path": hint?.transcriptPath ?? null,
                },
              }),
            ),
          )
          if (collected._tag === "Failure") {
            yield* Effect.logWarning(
              `artifact ingest collect failed (${provider.id}): ${collected.failure.message}`,
            )
            summaries.push({ ...summary, skipped: summary.skipped + 1 })
            continue
          }

          // Turn-end re-ingest only needs the session that changed; persist just
          // that one when a native id is given (parsing already happened above).
          const sessions = nativeSessionId
            ? collected.success.filter((rows) => rows.session.nativeSessionId === nativeSessionId)
            : collected.success

          for (const rows of sessions) {
            const persisted = yield* Effect.result(
              store.replaceSession(rows).pipe(
                Effect.withSpan("arc.ingest.persist", {
                  attributes: {
                    "arc.provider": provider.id,
                    "arc.native_session_id": rows.session.nativeSessionId,
                    "arc.messages": rows.messages.length,
                    "arc.tool_calls": rows.toolCalls.length,
                  },
                }),
              ),
            )
            if (persisted._tag === "Failure") {
              yield* Effect.logWarning(
                `artifact ingest persist failed ${provider.id}/${rows.session.nativeSessionId}: ${persisted.failure}`,
              )
              summary.skipped += 1
              continue
            }
            const target = yield* arc.targetSessionForNative(provider.id, rows.session.nativeSessionId)
            if (target) {
              yield* activity.record({
                workspaceRoot: rows.session.workspaceRoot,
                chatId: target.chatId,
                targetSessionId: target.id,
                source: "artifact-ingest",
                kind: "projection_started",
                actor: provider.id,
                payload: {
                  provider: provider.id,
                  nativeSessionId: rows.session.nativeSessionId,
                  sourcePath: rows.session.sourcePath,
                  triggerNativeSessionId: nativeSessionId ?? null,
                },
              })
            }
            const projected = yield* chat.ingestArtifactSession(rows).pipe(
              Effect.withSpan("arc.ingest.project", {
                attributes: {
                  "arc.provider": provider.id,
                  "arc.native_session_id": rows.session.nativeSessionId,
                  "arc.messages": rows.messages.length,
                },
              }),
            )
            if (target) {
              yield* activity.record({
                workspaceRoot: rows.session.workspaceRoot,
                chatId: target.chatId,
                targetSessionId: target.id,
                source: "artifact-ingest",
                kind: "projection_finished",
                actor: provider.id,
                payload: {
                  provider: provider.id,
                  nativeSessionId: rows.session.nativeSessionId,
                  sourcePath: rows.session.sourcePath,
                  changed: projected,
                  messages: rows.messages.length,
                  toolCalls: rows.toolCalls.length,
                  diagnostics: rows.diagnostics.length,
                  triggerNativeSessionId: nativeSessionId ?? null,
                },
              })
            }

            summary.sessions += 1
            summary.messages += rows.messages.length
            summary.toolCalls += rows.toolCalls.length
            summary.fileHints += rows.fileHints.length
            summary.diagnostics += rows.diagnostics.length
          }

          summaries.push(summary)
        }

        return summaries
        // Best-effort observation: a sweep failure degrades to an empty summary.
      }).pipe(
        Effect.withSpan("arc.ingest.workspace", {
          attributes: {
            "arc.workspace": workspace,
            "arc.filter": filter,
            "arc.native_session_id": hint?.nativeSessionId ?? null,
            "arc.transcript_path": hint?.transcriptPath ?? null,
          },
        }),
        bestEffort<ReadonlyArray<ProviderIngestSummary>>("artifact ingest failed", []),
      )

    const reingestAndReprojectChat = (chatId: ChatId, filter: Provider | "all" = "all") =>
      Effect.gen(function* () {
        // Re-ingest each of the chat's targets from the transcript arc bound to
        // it, not from the chat's workspace path. This is the manual repair door,
        // and a chat needing repair is exactly the one whose session has drifted
        // away from that path — reaching it through the workspace would rediscover
        // nothing, which is what made the drift unrecoverable from the UI.
        const targets = yield* arc.targetSessionsForChat(chatId)
        const ingest: Array<ProviderIngestSummary> = []
        for (const target of targets) {
          if (target.nativeTranscriptPath === null) continue
          ingest.push(
            ...(yield* ingestWorkspace(target.cwd, filter, {
              ...(target.nativeSessionId === null ? {} : { nativeSessionId: target.nativeSessionId }),
              transcriptPath: target.nativeTranscriptPath,
            })),
          )
        }
        // Targets with no bound transcript (never launched, or a provider arc
        // doesn't file-back) still need the workspace sweep to find anything.
        if (ingest.length === 0) {
          const workspace = yield* arc.workspacePathForChat(chatId)
          if (!workspace) {
            yield* Effect.logWarning(`chat reingest skipped; no workspace for chat ${chatId}`)
            return { ingest: [], reproject: { deleted: 0, inserted: 0 } }
          }
          ingest.push(...(yield* ingestWorkspace(workspace, filter)))
        }
        const reproject = yield* chat.reprojectChat(chatId)
        return { ingest, reproject }
        // Best-effort observation: degrade to an empty result on any failure.
      }).pipe(
        bestEffort<{
          readonly ingest: ReadonlyArray<ProviderIngestSummary>
          readonly reproject: { readonly deleted: number; readonly inserted: number }
        }>(`chat reingest/reproject failed (${chatId})`, {
          ingest: [],
          reproject: { deleted: 0, inserted: 0 },
        }),
      )

    return { ingestWorkspace, reingestAndReprojectChat }
  }),
)
