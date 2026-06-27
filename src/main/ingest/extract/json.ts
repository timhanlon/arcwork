import { Option, Schema } from "effect"

// Narrowing helpers for walking provider transcripts, whose records are
// `unknown`-typed JSON. Every provider normalizer re-derived this same quartet;
// hoisted here as the one home so they can't drift (the `arr` default did:
// claude returned `undefined`, pi returned `[]`).
//
// str/obj/arr are plain type-guards over already-parsed values. parseJson is the
// one that touches a raw string, so it goes through Schema's JSON codec rather
// than a hand-rolled `JSON.parse` + try/catch (see docs/effect-idiom-audit.md
// D1/D4).

export type Rec = Record<string, unknown>

/** A non-empty string, else undefined. */
export const str = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined

/** A plain object (not null, not an array), else undefined. */
export const obj = (v: unknown): Rec | undefined =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Rec) : undefined

/**
 * An array, else the empty array — so call sites can `.map`/iterate without a
 * null guard. (Resolves the prior drift: claude's variant returned `undefined`,
 * which its three call sites already collapsed to `[]`/"" anyway.)
 */
export const arr = (v: unknown): ReadonlyArray<unknown> => (Array.isArray(v) ? v : [])

const decodeJsonString = Schema.decodeUnknownOption(Schema.UnknownFromJsonString)

/**
 * Parse a JSON string to a plain object, or undefined on parse error / non-object.
 * The parse goes through Schema's JSON codec (no raw `JSON.parse` / try-catch);
 * `obj` then applies the exact plain-object narrowing (rejecting arrays/primitives).
 */
export const parseJson = (raw: string): Rec | undefined =>
  obj(Option.getOrUndefined(decodeJsonString(raw)))
