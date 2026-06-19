import { Context, Effect, Layer, PubSub, Stream } from "effect"
import type { SqlError } from "effect/unstable/sql/SqlError"
import { createHash } from "node:crypto"
import { nowIso } from "../clock.js"
import type {
  Citation,
  CitationKind,
  Work,
  WorkChange,
  WorkComment,
  WorkCommentInput,
  WorkCommentKind,
  WorkCommentListing,
  WorkCommentSubjectKind,
  WorkCreateInput,
  WorkExecution,
  WorkLinkType,
  WorkPriority,
  WorkProvenance,
  WorkReviseInput,
  WorkSearchQuery,
  WorkStatus,
  WorkSummary,
} from "../../shared/work.js"
import { newArcId } from "../../shared/ids.js"
import { arcRequestError, type ArcRequestError } from "../errors.js"
import { ArcStore } from "../db/store.js"
import {
  WORK_SCHEMA_VERSION,
  type WorkCommentRow,
  type WorkEdgeRow,
  type WorkNodeRow,
  type WorkProjectionRow,
} from "./schema.js"
import { WorkStore, type WorkCreateSpec, type WorkRevisionSpec } from "./store.js"

/**
 * The product verbs over the work graph — the door every transport (CLI, RPC,
 * later MCP) decodes into. `create` is the smallest proof: author intent that
 * passive observation can never capture ("investigate X", a handoff). It writes
 * one revision node, a fresh ref pointing at it, the ref-update log entry, and
 * the provenance/live edges implied by the input.
 *
 * Provenance is *derived*, not authored: the caller passes only what arc can't
 * know otherwise (`source`, and — for an out-of-process CLI — the session/chat
 * ids it inherited from the `ARC_*` env stamps). When `sessionId` is known a
 * `created_in_session` edge is written; otherwise it is simply absent, and the
 * work is a plain note. That gap is the v0 dependency the proposal names.
 */
/** A delegated unit of work joined to its current implementer target session —
 * the hydrated form of {@link DelegatedWorkRow} the monitoring projection reads. */
export interface DelegatedWork {
  readonly work: Work
  readonly targetSessionId: string
  readonly delegatedAt: string
}

export class WorkService extends Context.Service<
  WorkService,
  {
    readonly create: (
      input: WorkCreateInput,
      provenance: WorkProvenance,
    ) => Effect.Effect<Work, SqlError>
    /** Move a unit of work to a new status. Status is a workflow event on the
     * ref, not content: no new node, no ref move. `ArcRequestError` on unknown
     * work. */
    readonly updateStatus: (
      refId: string,
      status: WorkStatus,
      provenance: WorkProvenance,
    ) => Effect.Effect<Work, SqlError | ArcRequestError>
    /** Set a unit of work's priority. Like status, priority is a workflow event
     * on the ref (an append-only `priority_set` edge, latest wins), not content:
     * no new node, no ref move. A no-op when the priority is unchanged.
     * `ArcRequestError` on unknown work. */
    readonly updatePriority: (
      refId: string,
      priority: WorkPriority,
      provenance: WorkProvenance,
    ) => Effect.Effect<Work, SqlError | ArcRequestError>
    /** Edit authored content (title/body/labels). Mints a new immutable revision
     * node, CAS-moves the ref, and links it to the prior node with `revises`;
     * status is untouched. `ArcRequestError` on unknown work or a concurrent
     * edit (the ref drifted). */
    readonly revise: (
      refId: string,
      edits: WorkReviseInput,
      provenance: WorkProvenance,
    ) => Effect.Effect<Work, SqlError | ArcRequestError>
    /** Relate two units of work with a typed live edge (blocks/depends_on/…).
     * Both refs must exist; self-links and exact duplicates are rejected/no-op.
     * Returns the `from` work. `ArcRequestError` on unknown work or self-link. */
    readonly link: (
      fromRefId: string,
      type: WorkLinkType,
      toRefId: string,
      provenance: WorkProvenance,
      note?: string,
    ) => Effect.Effect<Work, SqlError | ArcRequestError>
    /** Stamp a typed external citation (commit/pr/url/file/session) onto an
     * existing unit of work — the post-creation form of the `citations` accepted
     * by {@link create}. Serializes to a `references` edge whose `toId` is
     * `kind:target`. Idempotent for the same (work, kind, target). Used by the
     * commit watcher to record commit→work without an agent writing a note.
     * `ArcRequestError` on unknown work. */
    readonly addCitation: (
      refId: string,
      citation: Citation,
      provenance: WorkProvenance,
      note?: string,
    ) => Effect.Effect<Work, SqlError | ArcRequestError>
    /** Record that a unit of work is delegated to a target session — a durable,
     * typed `delegated_to` edge from the ref to an *external* target-session id
     * (parallel to `created_in_session`; the session lives in ArcStore, not the
     * work graph). This is the queryable "what work is on this implementer?" link
     * a handoff leaves, distinct from a prose comment. Idempotent for the same
     * (work, session). `ArcRequestError` on unknown work. */
    readonly linkTargetSession: (
      refId: string,
      targetSessionId: string,
      provenance: WorkProvenance,
      note?: string,
    ) => Effect.Effect<Work, SqlError | ArcRequestError>
    readonly listOpen: Effect.Effect<ReadonlyArray<Work>, SqlError>
    /** The open work queue as thin headers (no `body`, no citations) — what
     * `arc.workspace_context` returns to orient an agent without shipping every
     * item's full markdown. Same order as {@link listOpen}; drill into a body
     * with {@link get}. */
    readonly listOpenSummaries: Effect.Effect<ReadonlyArray<WorkSummary>, SqlError>
    /** Every unit of work regardless of status, newest first — what the global
     * work navigator lists so it can filter open/done/superseded client-side
     * (`listOpen` deliberately drops the resolved statuses). */
    readonly listAll: Effect.Effect<ReadonlyArray<Work>, SqlError>
    /** All work authored in a given chat (any status), newest first — the
     * context-scoped view shown when that chat is selected. */
    readonly listForChat: (chatId: string) => Effect.Effect<ReadonlyArray<Work>, SqlError>
    /** Every delegated unit of work paired with its current implementer target
     * session — the typed reverse of {@link linkTargetSession}, so the monitoring
     * read model answers "what is delegated where?" from the graph, not comments.
     * Newest delegation first. */
    readonly listDelegated: Effect.Effect<ReadonlyArray<DelegatedWork>, SqlError>
    /** The work currently delegated to one implementer target session — the
     * target-scoped reverse lookup ("what is this implementer on right now?"),
     * so handoff-reuse and an orchestrator can answer it from the graph instead
     * of reading comments or scrollback. Only work whose *latest* `delegated_to`
     * edge points at `targetSessionId` is returned; newest delegation first. */
    readonly listDelegatedTo: (
      targetSessionId: string,
    ) => Effect.Effect<ReadonlyArray<DelegatedWork>, SqlError>
    /** Content search across title/body/labels, spanning every status by default
     * so resolved work stays findable. See {@link WorkSearchQuery}. */
    readonly search: (query: WorkSearchQuery) => Effect.Effect<ReadonlyArray<Work>, SqlError>
    readonly get: (refId: string) => Effect.Effect<Work | null, SqlError>
    /** Attach a comment to a unit of work. By default it anchors to the work's
     * *current revision node* (so the remark stays with the text it discussed);
     * `input.ref` anchors it to the durable ref instead. Provenance flows the
     * same path as create/revise/status/link. `ArcRequestError` on unknown work. */
    readonly comment: (
      refId: string,
      input: WorkCommentInput,
      provenance: WorkProvenance,
    ) => Effect.Effect<WorkComment, SqlError | ArcRequestError>
    /** List a work's comments. By default returns comments on the current
     * revision node plus ref-level comments; `opts.allRevisions` returns every
     * comment (including those left on prior revisions). Always reports
     * `olderRevisionCommentCount` so a caller can indicate older comments exist.
     * `ArcRequestError` on unknown work. */
    readonly listComments: (
      refId: string,
      opts?: { readonly allRevisions?: boolean },
    ) => Effect.Effect<WorkCommentListing, SqlError | ArcRequestError>
    /** Fires once per *real* mutation (no-op edits don't emit) so the renderer's
     * `arc:work` channel can invalidate its work reads. Every door (RPC, MCP)
     * runs through this one in-process service, so the push covers them all: it
     * replaces the reload-after-own-mutation the panes did, and the cross-pane
     * staleness where a status change in one pane left another's list stale. */
    readonly changes: Stream.Stream<WorkChange>
  }
>()("arc-electron/WorkService") {}

const contentHash = (parts: {
  title: string
  body: string
  labels: ReadonlyArray<string>
  status: string
}): string =>
  createHash("sha256")
    .update([parts.title, parts.body, parts.labels.join(","), parts.status].join("\u0000"))
    .digest("hex")

/** Execution provenance is a small JSON blob per row (one nullable column), not a
 * column per field — so the runtime story can grow without schema churn. An empty
 * execution stores nothing (null), and an undecodable/blank blob reads back as
 * undefined, so the provenance just omits `execution`. */
const encodeExecution = (execution: WorkExecution | undefined): string | null =>
  execution && (execution.harness || execution.model) ? JSON.stringify(execution) : null

const decodeExecution = (json: string | null): WorkExecution | undefined => {
  if (!json) return undefined
  try {
    const parsed = JSON.parse(json) as WorkExecution
    return parsed.harness || parsed.model ? parsed : undefined
  } catch {
    return undefined
  }
}

/** Citations serialize to a `references` edge whose `toId` is `kind:target`. */
const encodeCitationTarget = (c: Citation): string => `${c.kind}:${c.target}`
const decodeCitationTarget = (toId: string): Citation => {
  const idx = toId.indexOf(":")
  if (idx === -1) return { kind: "url", target: toId }
  return { kind: toId.slice(0, idx) as CitationKind, target: toId.slice(idx + 1) }
}

export const WorkServiceLive = Layer.effect(
  WorkService,
  Effect.gen(function* () {
    const store = yield* WorkStore
    const arcStore = yield* Effect.serviceOption(ArcStore)

    // Invalidation bus for the `arc:work` push channel. Unbounded so a publish
    // never blocks a mutation; consumers that fall behind just coalesce reads.
    const updates = yield* PubSub.unbounded<WorkChange>()
    const publishChange = (refId: string, chatId: string | null | undefined) =>
      PubSub.publish(updates, { refId, chatId: chatId ?? null })

    const scopedProvenance = (provenance: WorkProvenance) =>
      Effect.gen(function* () {
        if (arcStore._tag === "None") return provenance
        const arc = arcStore.value
        const chatId = provenance.chatId ??
          (provenance.sessionId ? yield* arc.chatIdForTargetSession(provenance.sessionId) : null) ??
          undefined
        const workspaceId =
          (chatId ? yield* arc.workspaceIdForChat(chatId) : null) ??
          (provenance.sessionId ? yield* arc.workspaceIdForTargetSession(provenance.sessionId) : null) ??
          provenance.workspaceId
        // Resolve the authoring session's execution runtime from trusted identity:
        // `harness` is the session's stable launch provider; `model` is the latest
        // model *observed* on its transcript/hook stream (mutable — a session can
        // switch models mid-run, so never the launch env default). Observed values
        // win over anything a caller voluntarily supplied; either may be absent.
        const harness =
          (provenance.sessionId ? yield* arc.providerForTargetSession(provenance.sessionId) : null) ??
          provenance.execution?.harness
        const model =
          (provenance.sessionId ? yield* arc.latestModelForTargetSession(provenance.sessionId) : null) ??
          provenance.execution?.model
        const execution: WorkExecution | undefined =
          harness || model
            ? { ...(harness ? { harness } : {}), ...(model ? { model } : {}) }
            : undefined
        return {
          ...provenance,
          ...(chatId ? { chatId } : {}),
          ...(workspaceId ? { workspaceId } : {}),
          ...(execution ? { execution } : {}),
        }
      })

    /** Hydrate a projection row into the full `Work` (labels + citations). */
    const toWork = (row: WorkProjectionRow) =>
      Effect.gen(function* () {
        const cites = yield* store.loadCitations(row.id)
        const labels = parseLabels(row.labelsJson)
        const execution = decodeExecution(row.executionJson)
        const work: Work = {
          _tag: "Work",
          id: row.id,
          nodeId: row.nodeId,
          title: row.title,
          body: row.body,
          labels,
          status: row.status as WorkStatus,
          priority: (row.priority ?? null) as WorkPriority | null,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
          provenance: {
            actor: row.actor ?? undefined,
            sessionId: row.sessionId ?? undefined,
            chatId: row.chatId ?? undefined,
            workspaceId: row.workspaceId ?? undefined,
            source: row.observedSource,
            ...(execution ? { execution } : {}),
          },
          citations: cites.map((c) => {
            // `ref` edges carry a raw graph ref id; its citation kind is the
            // cited ref's own `kind` (read via the join, defaulting to `work`).
            // External edges carry the `kind:target` locator, decoded directly.
            const cite: Citation =
              c.toKind === "ref"
                ? { kind: (c.refKind ?? "work") as CitationKind, target: c.target }
                : decodeCitationTarget(c.target)
            return c.note ? { ...cite, note: c.note } : cite
          }),
        }
        return work
      })

    const create = Effect.fn("WorkService.create")(
      (input: WorkCreateInput, provenance: WorkProvenance) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const now = yield* nowIso
          const refId = newArcId("work")
          const nodeId = newArcId("work_rev")
          const labels = input.labels ?? []
          const status = input.status ?? "open"
          const source = provenance.source

          // Common provenance stamp on every row this create writes.
          const stamp = {
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            observedSource: source,
            executionJson: encodeExecution(provenance.execution),
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }

          const edge = (
            type: string,
            toKind: string,
            toId: string,
            family: "provenance" | "live" | "workflow",
            edgeSource: WorkEdgeRow["source"],
            note: string | null = null,
          ): WorkEdgeRow => ({
            id: newArcId("work_edge"),
            type,
            fromKind: "ref",
            fromId: refId,
            toKind,
            toId,
            family,
            source: edgeSource,
            confidence: "high",
            note,
            actor: stamp.actor,
            sessionId: stamp.sessionId,
            workspaceId: stamp.workspaceId,
            observedSource: source,
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          })

          const edges: Array<WorkEdgeRow> = []
          // Provenance: arc observed which session authored this (when known).
          if (provenance.sessionId) {
            edges.push(
              edge("created_in_session", "external", provenance.sessionId, "provenance", "observed"),
            )
          }
          // Live: explicit citations → references edges. A citation of other
          // work is a real ref edge — raw ref id, traversable like supersedes —
          // so a graph query on the cited work finds it. file/commit/pr/url/
          // session have no ref, so they are external `kind:target` locators.
          for (const c of input.citations ?? []) {
            const toWorkRef = c.kind === "work"
            edges.push(
              edge(
                "references",
                toWorkRef ? "ref" : "external",
                toWorkRef ? c.target : encodeCitationTarget(c),
                "live",
                "observed",
                c.note ?? null,
              ),
            )
          }
          // Live: supersession the agent asserted (does not auto-retire the target in v0).
          for (const target of input.supersedes ?? []) {
            edges.push(edge("supersedes", "ref", target, "live", "user_confirmed"))
          }
          // Workflow: priority is an edge even at create (no node column — unlike
          // status's authored fallback), so an unset priority writes nothing.
          if (input.priority) {
            edges.push(edge("priority_set", "external", input.priority, "workflow", "user_confirmed"))
          }

          const spec: WorkCreateSpec = {
            node: {
              id: nodeId,
              kind: "work",
              contentHash: contentHash({ title: input.title, body: input.body, labels, status }),
              title: input.title,
              body: input.body,
              labelsJson: JSON.stringify(labels),
              status,
              actor: stamp.actor,
              sessionId: stamp.sessionId,
              chatId: provenance.chatId ?? null,
              workspaceId: stamp.workspaceId,
              deviceId: null,
              observedSource: source,
              executionJson: stamp.executionJson,
              createdAt: now,
              schemaVersion: WORK_SCHEMA_VERSION,
            },
            ref: {
              id: refId,
              kind: "work",
              currentNodeId: nodeId,
              displayName: input.title,
              location: null,
              actor: stamp.actor,
              workspaceId: stamp.workspaceId,
              createdAt: now,
              updatedAt: now,
              schemaVersion: WORK_SCHEMA_VERSION,
            },
            refUpdate: {
              id: newArcId("work_edge"), // ref-update log row; shares the edge id-space
              refId,
              oldNodeId: null,
              newNodeId: nodeId,
              actor: stamp.actor,
              sessionId: stamp.sessionId,
              workspaceId: stamp.workspaceId,
              deviceId: null,
              observedSource: source,
              createdAt: now,
              schemaVersion: WORK_SCHEMA_VERSION,
            },
            edges,
          }

          yield* store.createWork(spec)
          const row = yield* store.loadWork(refId)
          // The ref was just inserted in the same connection; loadWork must hit.
          if (!row) return yield* Effect.die(new Error(`work ${refId} vanished after create`))
          yield* publishChange(refId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const listOpen = Effect.gen(function* () {
      const rows = yield* store.loadOpenWork
      return yield* Effect.forEach(rows, toWork)
    })

    /** Project a row to a queue header — no body, no per-row citations query. */
    const toSummary = (row: WorkProjectionRow): WorkSummary => ({
      _tag: "WorkSummary",
      id: row.id,
      title: row.title,
      labels: parseLabels(row.labelsJson),
      status: row.status as WorkStatus,
      priority: (row.priority ?? null) as WorkPriority | null,
      updatedAt: row.updatedAt,
    })

    const listOpenSummaries = Effect.map(store.loadOpenWork, (rows) => rows.map(toSummary))

    const listAll = Effect.gen(function* () {
      const rows = yield* store.loadAllWork
      return yield* Effect.forEach(rows, toWork)
    })

    const listForChat = (chatId: string) =>
      Effect.gen(function* () {
        const rows = yield* store.loadWorkForChat(chatId)
        return yield* Effect.forEach(rows, toWork)
      })

    const listDelegated = Effect.gen(function* () {
      const rows = yield* store.loadDelegatedWork
      return yield* Effect.forEach(rows, (row) =>
        Effect.map(toWork(row), (work) => ({
          work,
          targetSessionId: row.targetSessionId,
          delegatedAt: row.delegatedAt,
        })),
      )
    })

    const listDelegatedTo = (targetSessionId: string) =>
      Effect.gen(function* () {
        const rows = yield* store.loadDelegatedWorkForTarget(targetSessionId)
        return yield* Effect.forEach(rows, (row) =>
          Effect.map(toWork(row), (work) => ({
            work,
            targetSessionId: row.targetSessionId,
            delegatedAt: row.delegatedAt,
          })),
        )
      })

    const search = (query: WorkSearchQuery) =>
      Effect.gen(function* () {
        const terms = query.query.split(/\s+/).filter((t) => t.length > 0)
        const rows = yield* store.searchWork({
          terms,
          labels: query.labels ?? [],
          statuses: query.statuses ?? [],
          // Pass through verbatim: an omitted limit means "no cap" (the store
          // drops the LIMIT clause), which the read surface relies on to count
          // and page the full match set. Callers that want a cap pass one.
          limit: query.limit,
        })
        return yield* Effect.forEach(rows, toWork)
      })

    const updateStatus = Effect.fn("WorkService.updateStatus")(
      (refId: string, status: WorkStatus, provenance: WorkProvenance) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))
          // No-op: a status that didn't change records nothing.
          if (current.status === status) return yield* toWork(current)

          const now = yield* nowIso
          // Status is a workflow fact, not content: append a `status_set` event
          // on the ref. No new content node, no ref move — the prose is unchanged.
          // The agent explicitly asserted it, so `user_confirmed`; `observedSource`
          // is the door it came through (cli/rpc).
          const statusEdge: WorkEdgeRow = {
            id: newArcId("work_edge"),
            type: "status_set",
            fromKind: "ref",
            fromId: refId,
            toKind: "external",
            toId: status,
            family: "workflow",
            source: "user_confirmed",
            confidence: "high",
            note: null,
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            observedSource: provenance.source,
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          yield* store.recordEdge(refId, statusEdge, now)
          const row = yield* store.loadWork(refId)
          if (!row) return yield* Effect.die(new Error(`work ${refId} vanished after status change`))
          yield* publishChange(refId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const updatePriority = Effect.fn("WorkService.updatePriority")(
      (refId: string, priority: WorkPriority, provenance: WorkProvenance) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))
          // No-op: re-asserting the same priority records nothing.
          if (current.priority === priority) return yield* toWork(current)

          const now = yield* nowIso
          // Priority is a workflow fact, not content: append a `priority_set` event
          // on the ref — no new content node, no ref move. Same shape as status.
          const priorityEdge: WorkEdgeRow = {
            id: newArcId("work_edge"),
            type: "priority_set",
            fromKind: "ref",
            fromId: refId,
            toKind: "external",
            toId: priority,
            family: "workflow",
            source: "user_confirmed",
            confidence: "high",
            note: null,
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            observedSource: provenance.source,
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          yield* store.recordEdge(refId, priorityEdge, now)
          const row = yield* store.loadWork(refId)
          if (!row) return yield* Effect.die(new Error(`work ${refId} vanished after priority change`))
          yield* publishChange(refId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const link = Effect.fn("WorkService.link")(
      (
        fromRefId: string,
        type: WorkLinkType,
        toRefId: string,
        provenance: WorkProvenance,
        note?: string,
      ) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          if (fromRefId === toRefId) {
            return yield* Effect.fail(arcRequestError("cannot link a unit of work to itself"))
          }
          const from = yield* store.loadWork(fromRefId)
          if (!from) return yield* Effect.fail(arcRequestError(`unknown work: ${fromRefId}`))
          const to = yield* store.loadWork(toRefId)
          if (!to) return yield* Effect.fail(arcRequestError(`unknown work: ${toRefId}`))

          // Idempotent: an identical (from, type, to) edge is a no-op.
          const existing = yield* store.loadEdges(fromRefId, type)
          if (existing.some((e) => e.toId === toRefId)) return yield* toWork(from)

          const now = yield* nowIso
          const edge: WorkEdgeRow = {
            id: newArcId("work_edge"),
            type,
            fromKind: "ref",
            fromId: fromRefId,
            toKind: "ref",
            toId: toRefId,
            family: "live",
            source: "user_confirmed",
            confidence: "high",
            note: note ?? null,
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            observedSource: provenance.source,
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          yield* store.recordEdge(fromRefId, edge, now)
          const row = yield* store.loadWork(fromRefId)
          if (!row) return yield* Effect.die(new Error(`work ${fromRefId} vanished after link`))
          yield* publishChange(fromRefId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const addCitation = Effect.fn("WorkService.addCitation")(
      (refId: string, citation: Citation, provenance: WorkProvenance, note?: string) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))

          // A `work` citation is a real ref edge (raw ref id, traversable);
          // everything else is an external `kind:target` locator — same split as
          // create's citation handling.
          const toWorkRef = citation.kind === "work"
          const toId = toWorkRef ? citation.target : encodeCitationTarget(citation)

          // Idempotent: an identical (work, kind, target) citation is a no-op.
          const existing = yield* store.loadEdges(refId, "references")
          if (existing.some((e) => e.toId === toId)) return yield* toWork(current)

          const now = yield* nowIso
          const edge: WorkEdgeRow = {
            id: newArcId("work_edge"),
            type: "references",
            fromKind: "ref",
            fromId: refId,
            toKind: toWorkRef ? "ref" : "external",
            toId,
            family: "live",
            source: "observed",
            confidence: "high",
            note: note ?? citation.note ?? null,
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            observedSource: provenance.source,
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          yield* store.recordEdge(refId, edge, now)
          const row = yield* store.loadWork(refId)
          if (!row) return yield* Effect.die(new Error(`work ${refId} vanished after addCitation`))
          yield* publishChange(refId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const linkTargetSession = Effect.fn("WorkService.linkTargetSession")(
      (refId: string, targetSessionId: string, provenance: WorkProvenance, note?: string) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))

          // Idempotent: an identical (work, session) delegation is a no-op.
          const existing = yield* store.loadEdges(refId, "delegated_to")
          if (existing.some((e) => e.toId === targetSessionId)) return yield* toWork(current)

          const now = yield* nowIso
          // `delegated_to` is a *live* edge to an external endpoint — the target
          // session id — exactly like `created_in_session` (sessions live in
          // ArcStore, outside the work node/ref space), but workflow-meaningful:
          // it's the durable answer to "what work is on this implementer?".
          const edge: WorkEdgeRow = {
            id: newArcId("work_edge"),
            type: "delegated_to",
            fromKind: "ref",
            fromId: refId,
            toKind: "external",
            toId: targetSessionId,
            family: "live",
            source: "user_confirmed",
            confidence: "high",
            note: note ?? null,
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            observedSource: provenance.source,
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          yield* store.recordEdge(refId, edge, now)
          const row = yield* store.loadWork(refId)
          if (!row) {
            return yield* Effect.die(new Error(`work ${refId} vanished after session link`))
          }
          yield* publishChange(refId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const revise = Effect.fn("WorkService.revise")(
      (refId: string, edits: WorkReviseInput, provenance: WorkProvenance) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))

          // Omitted fields keep their value; present fields replace (labels as a
          // whole set). Status is never edited here — it lives in events.
          const title = edits.title ?? current.title
          const body = edits.body ?? current.body
          const labels = edits.labels ?? parseLabels(current.labelsJson)
          const labelsJson = JSON.stringify(labels)

          // No-op: identical content writes no revision.
          if (title === current.title && body === current.body && labelsJson === current.labelsJson) {
            return yield* toWork(current)
          }

          const now = yield* nowIso
          const newNodeId = newArcId("work_rev")
          const source = provenance.source
          // node.status carries the current status forward only as the authored
          // fallback — actual status stays in status_set events on the ref.
          const node: WorkNodeRow = {
            id: newNodeId,
            kind: "work",
            contentHash: contentHash({ title, body, labels, status: current.status }),
            title,
            body,
            labelsJson,
            status: current.status,
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            chatId: provenance.chatId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            deviceId: null,
            observedSource: source,
            executionJson: encodeExecution(provenance.execution),
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          const spec: WorkRevisionSpec = {
            refId,
            expectedOldNodeId: current.nodeId,
            node,
            refUpdate: {
              id: newArcId("work_edge"),
              refId,
              oldNodeId: current.nodeId,
              newNodeId,
              actor: provenance.actor ?? null,
              sessionId: provenance.sessionId ?? null,
              workspaceId: provenance.workspaceId ?? null,
              deviceId: null,
              observedSource: source,
              createdAt: now,
              schemaVersion: WORK_SCHEMA_VERSION,
            },
            // `revises` points to the specific frozen node it supersedes (per the
            // edge vocabulary), not the ref — so the revision chain is exact.
            revisesEdge: {
              id: newArcId("work_edge"),
              type: "revises",
              fromKind: "node",
              fromId: newNodeId,
              toKind: "node",
              toId: current.nodeId,
              family: "provenance",
              source: "observed",
              confidence: "high",
              note: null,
              actor: provenance.actor ?? null,
              sessionId: provenance.sessionId ?? null,
              workspaceId: provenance.workspaceId ?? null,
              observedSource: source,
              createdAt: now,
              schemaVersion: WORK_SCHEMA_VERSION,
            },
            updatedAt: now,
          }

          yield* store.applyRevision(spec).pipe(
            Effect.catchTag("arc/WorkRefConflict", (e) =>
              Effect.fail(arcRequestError(`work ${e.refId} changed concurrently; reload and retry`)),
            ),
          )
          const row = yield* store.loadWork(refId)
          if (!row) return yield* Effect.die(new Error(`work ${refId} vanished after revision`))
          yield* publishChange(refId, provenance.chatId)
          return yield* toWork(row)
        }),
    )

    const get = (refId: string) =>
      Effect.gen(function* () {
        const row = yield* store.loadWork(refId)
        return row ? yield* toWork(row) : null
      })

    /** Hydrate a stored comment row into the shared `WorkComment` shape. */
    const toComment = (row: WorkCommentRow): WorkComment => {
      const execution = decodeExecution(row.executionJson)
      return {
        _tag: "WorkComment",
        id: row.id,
        workRefId: row.workRefId,
        subjectKind: row.subjectKind as WorkCommentSubjectKind,
        subjectId: row.subjectId,
        body: row.body,
        kind: row.kind as WorkCommentKind,
        createdAt: row.createdAt,
        provenance: {
          actor: row.actor ?? undefined,
          sessionId: row.sessionId ?? undefined,
          chatId: row.chatId ?? undefined,
          workspaceId: row.workspaceId ?? undefined,
          source: row.observedSource,
          ...(execution ? { execution } : {}),
        },
      }
    }

    const comment = Effect.fn("WorkService.comment")(
      (refId: string, input: WorkCommentInput, provenance: WorkProvenance) =>
        Effect.gen(function* () {
          provenance = yield* scopedProvenance(provenance)
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))

          const now = yield* nowIso
          // Default subject is the current revision node, so the remark stays
          // pinned to the text it discussed when the work is later revised; `ref`
          // anchors it to the durable item instead.
          const toRef = input.ref === true
          const row: WorkCommentRow = {
            id: newArcId("comment"),
            workRefId: refId,
            subjectKind: toRef ? "ref" : "node",
            subjectId: toRef ? refId : current.nodeId,
            body: input.body,
            kind: input.kind ?? "comment",
            actor: provenance.actor ?? null,
            sessionId: provenance.sessionId ?? null,
            chatId: provenance.chatId ?? null,
            workspaceId: provenance.workspaceId ?? null,
            deviceId: null,
            observedSource: provenance.source,
            executionJson: encodeExecution(provenance.execution),
            createdAt: now,
            schemaVersion: WORK_SCHEMA_VERSION,
          }
          yield* store.insertComment(row)
          yield* publishChange(refId, provenance.chatId)
          return toComment(row)
        }),
    )

    const listComments = Effect.fn("WorkService.listComments")(
      (refId: string, opts?: { readonly allRevisions?: boolean }) =>
        Effect.gen(function* () {
          const current = yield* store.loadWork(refId)
          if (!current) return yield* Effect.fail(arcRequestError(`unknown work: ${refId}`))

          const all = (yield* store.loadComments(refId)).map(toComment)
          // A node comment whose subject is not the current revision was left on
          // a prior revision — the count `get`/`comments` surface as an indicator.
          const olderRevisionCommentCount = all.filter(
            (c) => c.subjectKind === "node" && c.subjectId !== current.nodeId,
          ).length
          // Default view: current-revision node comments + ref comments (which
          // are revision-independent, so always pertinent). `allRevisions` keeps
          // the prior-revision comments too.
          const comments = opts?.allRevisions
            ? all
            : all.filter((c) => c.subjectKind === "ref" || c.subjectId === current.nodeId)
          return { currentNodeId: current.nodeId, comments, olderRevisionCommentCount }
        }),
    )

    return {
      create,
      updateStatus,
      updatePriority,
      revise,
      link,
      addCitation,
      linkTargetSession,
      listOpen,
      listOpenSummaries,
      listAll,
      listForChat,
      listDelegated,
      listDelegatedTo,
      search,
      get,
      comment,
      listComments,
      changes: Stream.fromPubSub(updates),
    } as const
  }),
)

const parseLabels = (json: string): ReadonlyArray<string> => {
  try {
    const value = JSON.parse(json)
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : []
  } catch {
    return []
  }
}
