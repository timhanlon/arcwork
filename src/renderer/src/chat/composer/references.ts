import type { TargetSession } from "../../../../shared/instance.js"
import type { Work } from "../../../../shared/work.js"

/**
 * A thing the composer's `@` picker can drop into a prompt: a piece of work, a
 * file in the workspace, or a running target session. The kinds line up with the
 * work-graph's {@link CitationKind} so a reference can later harden into a real
 * citation edge; v0 inserts a plain text token an agent can read and resolve.
 */
export type ReferenceKind = "work" | "file" | "session"

export interface ReferenceCandidate {
  readonly kind: ReferenceKind
  /** Stable identity for React keys and Base UI item values. */
  readonly key: string
  /** Primary text shown in the row and matched against the query. */
  readonly label: string
  /** Secondary muted text (a path's directory, a session's cwd, a work status). */
  readonly detail?: string
  /**
   * For work and files, the text spliced into the draft after the trigger, so
   * the reference reads as a bare path for files (CLI muscle memory) or the
   * durable work id for work. For sessions this is the target id: selecting one
   * retargets the composer rather than inserting any text.
   */
  readonly insertText: string
}

/** Build a candidate per work item authored in this chat. */
export const workCandidates = (work: ReadonlyArray<Work>): ReadonlyArray<ReferenceCandidate> =>
  work.map((w) => ({
    kind: "work",
    key: w.id,
    label: w.title,
    detail: `${w.status} · ${w.id}`,
    insertText: w.id,
  }))

/** Build a candidate per session in this chat (a live or resumable target). */
export const sessionCandidates = (
  sessions: ReadonlyArray<TargetSession>,
): ReadonlyArray<ReferenceCandidate> =>
  sessions.map((s) => ({
    kind: "session",
    key: s.id,
    label: s.provider,
    detail: s.id,
    insertText: s.id,
  }))

/** Build a candidate per workspace file path (relative, POSIX). */
export const fileCandidates = (files: ReadonlyArray<string>): ReadonlyArray<ReferenceCandidate> =>
  files.map((p) => {
    const slash = p.lastIndexOf("/")
    return {
      kind: "file",
      key: `file:${p}`,
      label: slash >= 0 ? p.slice(slash + 1) : p,
      detail: slash >= 0 ? p.slice(0, slash) : undefined,
      insertText: p,
    }
  })

/**
 * Subsequence fuzzy score of `query` against `text` (case-insensitive). Returns
 * a number ≥ 0 when every query char appears in order, or -1 for no match.
 * Higher is better: contiguous runs and an early first match score more, so
 * "ucp" ranks `UnifiedChatPane` above an incidental u…c…p scatter.
 */
export const fuzzyScore = (query: string, text: string): number => {
  if (query.length === 0) return 0
  const q = query.toLowerCase()
  const t = text.toLowerCase()
  let score = 0
  let ti = 0
  let lastMatch = -1
  for (let qi = 0; qi < q.length; qi++) {
    const ch = q[qi]!
    const found = t.indexOf(ch, ti)
    if (found === -1) return -1
    // Reward adjacency (run continues) and an early start; penalize gaps.
    if (found === lastMatch + 1) score += 3
    else score += 1
    if (found === 0) score += 2
    lastMatch = found
    ti = found + 1
  }
  // Shorter haystacks with the same match are tighter; nudge them up.
  return score - text.length * 0.01
}

/**
 * Filter + rank candidates for a query. An empty query keeps the natural order
 * (work, then files, then sessions as passed in) so typing a bare `@` shows the
 * list; a non-empty query fuzzy-matches the label (and, for files, the full
 * path so a directory fragment still finds it) and sorts best-first. Capped so
 * the popup never renders thousands of rows.
 */
export const filterCandidates = (
  candidates: ReadonlyArray<ReferenceCandidate>,
  query: string,
  limit = 50,
): ReadonlyArray<ReferenceCandidate> => {
  if (query.length === 0) return candidates.slice(0, limit)
  const haystack = (c: ReferenceCandidate): string =>
    c.kind === "file" ? c.insertText : c.label
  const scored: Array<{ c: ReferenceCandidate; score: number }> = []
  for (const c of candidates) {
    const score = fuzzyScore(query, haystack(c))
    if (score >= 0) scored.push({ c, score })
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, limit).map((s) => s.c)
}

/**
 * The active `@`-mention at the caret, or null. A trigger only counts at a word
 * boundary (start of text or after whitespace) so emails and `a@b` don't fire
 * it; the query runs from just after the trigger to the caret and breaks on
 * whitespace. `start` is the trigger's index, used to splice the chosen token in.
 */
export interface ActiveMention {
  readonly start: number
  readonly query: string
}

export const detectMention = (
  text: string,
  caret: number,
  trigger: string,
): ActiveMention | null => {
  for (let i = caret - 1; i >= 0; i--) {
    const ch = text[i]!
    if (ch === trigger) {
      const prev = i > 0 ? text[i - 1]! : ""
      if (i === 0 || /\s/.test(prev)) return { start: i, query: text.slice(i + 1, caret) }
      return null
    }
    if (/\s/.test(ch)) return null
  }
  return null
}

/** Splice the chosen reference token in for the active `@query`, return the new
 * draft and the caret offset that should follow it. The trigger opens the picker
 * but is not part of the inserted reference. */
export const applyReference = (
  text: string,
  mention: ActiveMention,
  candidate: ReferenceCandidate,
  trigger: string,
): { readonly value: string; readonly caret: number } => {
  const before = text.slice(0, mention.start)
  const after = text.slice(mention.start + trigger.length + mention.query.length)
  const token = `${candidate.insertText} `
  return { value: `${before}${token}${after}`, caret: before.length + token.length }
}

/**
 * Delete the active `@query` without inserting anything — used when the mention
 * is a *command* rather than prose. A session reference retargets the composer
 * (see {@link ReferenceCandidate}); the `@claude` text has done its job and
 * shouldn't linger in the message body.
 */
export const removeMention = (
  text: string,
  mention: ActiveMention,
  trigger: string,
): { readonly value: string; readonly caret: number } => {
  const before = text.slice(0, mention.start)
  const after = text.slice(mention.start + trigger.length + mention.query.length)
  return { value: `${before}${after}`, caret: before.length }
}
