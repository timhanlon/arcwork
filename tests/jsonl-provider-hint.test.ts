import { Effect, Layer } from "effect"
import type { FileSystem, Path } from "effect"
import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem"
import * as NodePath from "@effect/platform-node/NodePath"
import * as os from "node:os"
import * as fs from "node:fs"
import * as nodePath from "node:path"
import { afterAll, beforeAll, describe, expect, it } from "vitest"
import { makeJsonlSessionProvider } from "../src/main/ingest/providers/jsonl-provider.js"
import type { ExtractedRows } from "../src/main/ingest/db/schema.js"

// Minimal flat-JSONL provider over a temp root: header line is {id, cwd}, and
// normalize just stamps the session id so we can see which files were parsed.
const makeProvider = (root: string) =>
  makeJsonlSessionProvider({
    id: "codex",
    root: () => root,
    readMeta: (line) => {
      const meta = JSON.parse(line) as { id: string; cwd: string }
      return { nativeSessionId: meta.id, cwd: meta.cwd }
    },
    normalize: (_records, options): ExtractedRows => ({
      session: {
        id: `codex:${options.nativeSessionId}`,
        provider: "codex",
        nativeSessionId: options.nativeSessionId,
        workspaceRoot: options.workspaceRoot,
        title: null,
        createdAt: null,
        updatedAt: null,
        sourcePath: options.sourcePath,
        rawMetadataJson: null,
      },
      messages: [],
      toolCalls: [],
      fileHints: [],
      usageEvents: [],
      diagnostics: [],
    }),
  })

let root: string
const cwd = "/repo/main"

beforeAll(() => {
  root = fs.mkdtempSync(nodePath.join(os.tmpdir(), "arc-jsonl-"))
  const write = (name: string, id: string) =>
    fs.writeFileSync(nodePath.join(root, name), `${JSON.stringify({ id, cwd })}\n{"event":1}\n`)
  write("a.jsonl", "sess-a")
  write("b.jsonl", "sess-b")
  // A third session in a different workspace, to confirm cwd matching still holds.
  fs.writeFileSync(nodePath.join(root, "c.jsonl"), `${JSON.stringify({ id: "sess-c", cwd: "/repo/other" })}\n`)
})

afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

const platform = Layer.mergeAll(NodeFileSystem.layer, NodePath.layer)
const run = <A>(program: Effect.Effect<A, unknown, FileSystem.FileSystem | Path.Path>): Promise<A> =>
  Effect.runPromise(program.pipe(Effect.provide(platform)) as Effect.Effect<A, never>)

describe("jsonl provider collect hint", () => {
  it("parses only the hinted session, not every cwd-matching file", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const provider = yield* makeProvider(root)
        const rows = yield* provider.collect(cwd, "sess-a")
        return rows.map((r) => r.session.nativeSessionId)
      }),
    )
    expect(ids).toEqual(["sess-a"])
  })

  it("without a hint, returns every session in the workspace", async () => {
    const ids = await run(
      Effect.gen(function* () {
        const provider = yield* makeProvider(root)
        const rows = yield* provider.collect(cwd)
        return rows.map((r) => r.session.nativeSessionId).sort()
      }),
    )
    // Both workspace sessions, and only those — the other-cwd session is excluded.
    expect(ids).toEqual(["sess-a", "sess-b"])
  })
})
