import { Schema } from "effect"
import { typeidUnboxed } from "typeid-js"

export type ArcIdPrefix =
  | "activity"
  | "chat"
  | "hook"
  | "message"
  | "pane"
  | "run"
  | "target"
  | "workspace"
  // a comm endpoint a worker talks through (harness/model/preset)
  | "channel"
  // git/github domain read model: a local clone, its worktrees, and a synced PR
  | "repo"
  | "worktree"
  | "pr"
  // document-graph substrate: work ref identity, its revision nodes, and edges
  | "work"
  | "work_rev"
  | "work_edge"
  // a comment on a work revision node or its durable ref
  | "comment"

/**
 * The suffix every TypeID carries after `prefix_`: 26 chars of Crockford base32
 * (lowercase, no i/l/o/u). Validated on decode so a malformed or wrong-prefix id
 * is rejected at the seam rather than flowing in as an opaque `Schema.String`.
 */
const TYPEID_SUFFIX = "[0-9a-hjkmnp-tv-z]{26}"

/**
 * Branded schema factory keyed by TypeID prefix. Decode validates the full
 * `prefix_<suffix>` shape and brands the result, so every id crossing the Rpc
 * seam is checked for the right prefix and is type-distinct from other ids.
 */
export const ArcId = <const P extends ArcIdPrefix>(prefix: P) =>
  Schema.String.pipe(
    Schema.check(Schema.isPattern(new RegExp(`^${prefix}_${TYPEID_SUFFIX}$`))),
    Schema.brand(`ArcId:${prefix}`),
  )

/**
 * A TypeID branded by its prefix. Two ids with different prefixes (a `chat_…`
 * and a `workspace_…`) are now distinct types, so they can't be interchanged
 * even though both are strings at runtime. Defined as the factory schema's own
 * decoded type, so a minted/decoded id is exactly this with no cast needed.
 */
export type ArcId<P extends ArcIdPrefix> = ReturnType<typeof ArcId<P>>["Type"]

/** Mint a fresh branded id for a prefix — constructed through the schema, so the
 * minted value runs the same prefix check it'll be validated against on decode. */
export const newArcId = <const P extends ArcIdPrefix>(prefix: P): ArcId<P> =>
  ArcId(prefix).make(typeidUnboxed(prefix))

/**
 * Brand an id string whose prefix is already guaranteed — for test fixtures and
 * trusted boundaries where the value isn't a freshly-minted or decoded id. Skips
 * the pattern check (so deliberately-short fixture ids like `chat_a` are fine);
 * use {@link newArcId} to mint and decode to validate untrusted input. */
export const arcId = <const P extends ArcIdPrefix>(prefix: P, value: string): ArcId<P> =>
  ArcId(prefix).make(value, { disableChecks: true })

/** {@link arcId} that passes `null`/`undefined` through — for nullable id columns
 * and optional env stamps read at a trusted boundary. */
export const arcIdOrNull = <const P extends ArcIdPrefix>(
  prefix: P,
  value: string | null | undefined,
): ArcId<P> | null => (value == null ? null : arcId(prefix, value))

// ── The branded id registry — one schema + type per prefix. ───────────────────
// Domain modules import the ids they reference from here, so a `workspaceId`
// field is the same `WorkspaceId` everywhere it appears.

export const WorkspaceId = ArcId("workspace")
export type WorkspaceId = typeof WorkspaceId.Type

export const ChatId = ArcId("chat")
export type ChatId = typeof ChatId.Type

export const MessageId = ArcId("message")
export type MessageId = typeof MessageId.Type

export const RunId = ArcId("run")
export type RunId = typeof RunId.Type

export const TargetId = ArcId("target")
export type TargetId = typeof TargetId.Type

export const WorkId = ArcId("work")
export type WorkId = typeof WorkId.Type

export const WorkRevId = ArcId("work_rev")
export type WorkRevId = typeof WorkRevId.Type

export const WorkEdgeId = ArcId("work_edge")
export type WorkEdgeId = typeof WorkEdgeId.Type

export const CommentId = ArcId("comment")
export type CommentId = typeof CommentId.Type

export const ActivityId = ArcId("activity")
export type ActivityId = typeof ActivityId.Type

export const HookId = ArcId("hook")
export type HookId = typeof HookId.Type

export const PaneId = ArcId("pane")
export type PaneId = typeof PaneId.Type

// git/github read model: a local clone, its worktrees, and a synced PR.
export const RepositoryId = ArcId("repo")
export type RepositoryId = typeof RepositoryId.Type

export const WorktreeId = ArcId("worktree")
export type WorktreeId = typeof WorktreeId.Type

export const PrId = ArcId("pr")
export type PrId = typeof PrId.Type
