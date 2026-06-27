// The pure JSONL -> session pipeline for Claude transcripts (ported from
// SpecStory's claudecode parser). Claude's JSONL is an append-only event log,
// not a clean transcript: records must be deduped, linked into parent/child
// DAGs, merged across resumed sessions, and flattened by timestamp.
//
// Split out of claude.ts: this is the gnarliest, self-contained part of the
// provider and depends on nothing but the shared narrowing helpers, so it lives
// on its own (and its tests need not drag in the normalize/IO surface).
import { type Rec, str } from "../extract/json.js"

const cmpStr = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0)

/**
 * Per-file pre-pass: a sidechain (subagent) record with no parent is re-parented
 * to the prior record so it stays attached to the conversation it branched from.
 */
export const rewriteSidechains = (records: ReadonlyArray<Rec>): ReadonlyArray<Rec> => {
  let lastUuid: string | undefined
  return records.map((r) => {
    let rec = r
    if (r["isSidechain"] === true && (r["parentUuid"] === null || r["parentUuid"] === undefined) && lastUuid) {
      rec = { ...r, parentUuid: lastUuid }
    }
    const uuid = str(r["uuid"])
    if (uuid) lastUuid = uuid
    return rec
  })
}

/** Dedup by uuid (keep earliest timestamp), drop records without a uuid, sort by timestamp. */
export const dedupeByUuid = (records: ReadonlyArray<Rec>): ReadonlyArray<Rec> => {
  const byUuid = new Map<string, Rec>()
  for (const r of records) {
    const uuid = str(r["uuid"])
    if (!uuid) continue
    const existing = byUuid.get(uuid)
    if (!existing) {
      byUuid.set(uuid, r)
    } else if ((str(r["timestamp"]) ?? "") < (str(existing["timestamp"]) ?? "")) {
      byUuid.set(uuid, r)
    }
  }
  return [...byUuid.values()].sort((a, b) => cmpStr(str(a["timestamp"]) ?? "", str(b["timestamp"]) ?? ""))
}

/** Build a parent/child DAG for each root (parentUuid == null/absent). */
export const buildDags = (records: ReadonlyArray<Rec>): ReadonlyArray<ReadonlyArray<Rec>> => {
  const byUuid = new Map<string, Rec>()
  const childrenOf = new Map<string, Array<Rec>>()
  for (const r of records) {
    const uuid = str(r["uuid"])
    if (uuid) byUuid.set(uuid, r)
  }
  for (const r of records) {
    const parent = str(r["parentUuid"])
    if (parent) {
      const list = childrenOf.get(parent) ?? []
      list.push(r)
      childrenOf.set(parent, list)
    }
  }

  const dags: Array<Array<Rec>> = []
  for (const root of records) {
    if (root["parentUuid"] !== null && root["parentUuid"] !== undefined) continue
    const dag: Array<Rec> = []
    const visited = new Set<string>()
    const traverse = (node: Rec): void => {
      const uuid = str(node["uuid"])
      if (!uuid || visited.has(uuid)) return
      visited.add(uuid)
      dag.push(node)
      const children = (childrenOf.get(uuid) ?? [])
        .filter((c) => {
          const cu = str(c["uuid"])
          return cu !== undefined && byUuid.has(cu)
        })
        .sort((a, b) => cmpStr(str(a["timestamp"]) ?? "", str(b["timestamp"]) ?? ""))
      for (const child of children) traverse(child)
    }
    traverse(root)
    if (dag.length > 0) dags.push(dag)
  }
  return dags
}

/** Merge DAGs that share a sessionId (resumed sessions fragment across roots/files). */
export const mergeBySessionId = (
  dags: ReadonlyArray<ReadonlyArray<Rec>>,
): ReadonlyArray<ReadonlyArray<Rec>> => {
  const groups = new Map<string, Array<ReadonlyArray<Rec>>>()
  let anon = 0
  for (const dag of dags) {
    if (dag.length === 0) continue
    let sessionId: string | undefined
    for (const r of dag) {
      const s = str(r["sessionId"])
      if (s) {
        sessionId = s
        break
      }
    }
    const key = sessionId ?? `no-session-${anon++}`
    const group = groups.get(key) ?? []
    group.push(dag)
    groups.set(key, group)
  }
  const merged: Array<ReadonlyArray<Rec>> = []
  for (const group of groups.values()) {
    merged.push(group.length === 1 ? group[0]! : group.flat())
  }
  return merged
}

/** Flatten a DAG to timestamp order, using parent/child then uuid as tiebreakers. */
export const flattenDag = (dag: ReadonlyArray<Rec>): ReadonlyArray<Rec> =>
  [...dag].sort((a, b) => {
    const ta = str(a["timestamp"]) ?? ""
    const tb = str(b["timestamp"]) ?? ""
    if (ta !== tb) return ta < tb ? -1 : 1
    const ua = str(a["uuid"]) ?? ""
    const ub = str(b["uuid"]) ?? ""
    if (str(a["parentUuid"]) === ub) return 1
    if (str(b["parentUuid"]) === ua) return -1
    return cmpStr(ua, ub)
  })

export interface ClaudeSession {
  readonly sessionId: string
  readonly records: ReadonlyArray<Rec>
}

/** Run the full dedup -> DAG -> merge -> flatten pipeline over all project files. */
export const parseClaudeSessions = (
  perFile: ReadonlyArray<ReadonlyArray<Rec>>,
): ReadonlyArray<ClaudeSession> => {
  const all: Array<Rec> = []
  for (const records of perFile) all.push(...rewriteSidechains(records))
  const merged = mergeBySessionId(buildDags(dedupeByUuid(all)))
  const sessions: Array<ClaudeSession> = []
  for (const dag of merged) {
    const flat = flattenDag(dag)
    if (flat.length === 0) continue
    let sessionId: string | undefined
    for (const r of flat) {
      const s = str(r["sessionId"])
      if (s) {
        sessionId = s
        break
      }
    }
    if (!sessionId) continue
    sessions.push({ sessionId, records: flat })
  }
  return sessions
}
