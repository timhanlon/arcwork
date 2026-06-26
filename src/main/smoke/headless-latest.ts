import fs from "node:fs"
import os from "node:os"
import path from "node:path"

/**
 * The coordinates `arc-headless` publishes on boot so `arc-drive` can find the
 * live harness with zero arguments. The harness DB lives in a random temp dir
 * (so a run never collides with a real app), which means the driver can't
 * discover it by location — instead the harness writes this one well-known file
 * and the driver reads it. Latest boot wins; a stale file just points at a dead
 * port, which the driver surfaces as a connection error.
 */
export interface HeadlessLatest {
  readonly mcpUrl: string | undefined
  readonly dbPath: string
  readonly cwd: string
  readonly chatId: string
  readonly workspaceId: string
  /** Ready-to-use `Authorization: Bearer` value — `target_<26>:<chatId>`, the
   * provenance the MCP server stamps onto the driver's writes. */
  readonly bearer: string
}

/** Fixed path under the OS temp dir — same string computed by harness and driver. */
export const headlessLatestPath = (): string => path.join(os.tmpdir(), "arc-headless-latest.json")

export const writeHeadlessLatest = (info: HeadlessLatest): void => {
  fs.writeFileSync(headlessLatestPath(), `${JSON.stringify(info, null, 2)}\n`)
}

/** Read the published coordinates, or `undefined` if no harness has booted (file
 * absent / unreadable). A trusted local file written by our own harness, so a
 * plain cast matches the smoke-script style (cf. `arc-headless` reading
 * `arc-mcp.json`). */
export const readHeadlessLatest = (): HeadlessLatest | undefined => {
  try {
    return JSON.parse(fs.readFileSync(headlessLatestPath(), "utf8")) as HeadlessLatest
  } catch {
    return undefined
  }
}
