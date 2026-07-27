import { Effect, Layer } from "effect"
import type { FileSystem, Path } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as os from "node:os"
import * as fs from "node:fs"
import * as nodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeClaudeProvider } from "../src/main/ingest/providers/claude.js"

// Claude files a session's transcript under a directory derived from the cwd the
// session started in. Relocating — entering a worktree, and equally a plain `cd`
// once the hook cwd is what discovery keys off — moves the file to a directory
// that the target's recorded cwd no longer derives. Discovery by cwd then finds
// nothing, silently: ingest reports zero sessions and the transcript freezes.
const transcript = (sessionId: string) =>
  [
    {
      type: "user",
      uuid: "u1",
      parentUuid: null,
      sessionId,
      timestamp: "2026-07-27T20:17:52.995Z",
      message: { role: "user", content: "what are the api.test.ts failures?" },
    },
    {
      type: "assistant",
      uuid: "a1",
      parentUuid: "u1",
      sessionId,
      timestamp: "2026-07-27T20:18:24.761Z",
      message: { content: [{ type: "text", text: "They were an artifact of the worktree." }] },
    },
  ]
    .map((r) => JSON.stringify(r))
    .join("\n")

const sessionId = "f9b10a4f-a6b4-45db-a7b6-dc94439a4774"

let relocatedDir: string
let transcriptPath: string
// The cwd the target was launched from and still has on record. Nothing is ever
// filed under it here, mirroring a session that has moved on.
const launchCwd = "/repo/minima"

beforeAll(() => {
  relocatedDir = fs.mkdtempSync(nodePath.join(os.tmpdir(), "arc-claude-"))
  transcriptPath = nodePath.join(relocatedDir, `${sessionId}.jsonl`)
  fs.writeFileSync(transcriptPath, `${transcript(sessionId)}\n`)
})

afterAll(() => fs.rmSync(relocatedDir, { recursive: true, force: true }))

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const run = <A>(program: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(platform)) as Effect.Effect<A, never>)

const collect = (hint?: { nativeSessionId?: string; transcriptPath?: string }) =>
  run(
    Effect.gen(function* () {
      const provider = yield* makeClaudeProvider
      const rows = yield* provider.collect(launchCwd, hint)
      return rows
    }),
  )

describe("claude transcript path hint", () => {
  it("reads the transcript arc has bound, not the one the cwd derives", async () => {
    const rows = await collect({ nativeSessionId: sessionId, transcriptPath })
    expect(rows.map((r) => r.session.nativeSessionId)).toEqual([sessionId])
    expect(rows[0]?.messages.map((m) => m.role)).toEqual(["user", "assistant"])
  })

  it("finds nothing from the stale cwd alone", async () => {
    expect(await collect({ nativeSessionId: sessionId })).toEqual([])
  })

  it("falls back to cwd discovery when the hinted transcript is gone", async () => {
    const rows = await collect({
      nativeSessionId: sessionId,
      transcriptPath: nodePath.join(relocatedDir, "resumed-elsewhere.jsonl"),
    })
    expect(rows).toEqual([])
  })
})
