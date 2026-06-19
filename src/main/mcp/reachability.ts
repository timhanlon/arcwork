import { createConnection } from "node:net"

/**
 * **Is the MCP endpoint actually live?** A TCP connect probe against the host/port
 * of a discovered MCP URL. `arc-mcp` uses it to refuse emitting a
 * client config that points at a dead port — the exact failure that bit Codex,
 * whose `config.toml` still named `http://127.0.0.1:56386/mcp` after the app that
 * served it was gone (`work_01ktx78crkfqbskfxqf77jgkjh`).
 *
 * A successful TCP connect is the acceptance condition (the port is bound and
 * accepting), not a full MCP handshake — cheap, synchronous-feeling, and enough
 * to tell "something is listening" from "nothing is there". Kept out of the CLI
 * module (which runs `main()` on import) so it is directly testable.
 */
export const isEndpointReachable = (url: string, timeoutMs = 750): Promise<boolean> => {
  let host: string
  let port: number
  try {
    const parsed = new URL(url)
    host = parsed.hostname
    port = parsed.port ? Number.parseInt(parsed.port, 10) : parsed.protocol === "https:" ? 443 : 80
  } catch {
    return Promise.resolve(false)
  }
  if (!Number.isInteger(port) || port <= 0) return Promise.resolve(false)

  return new Promise<boolean>((resolve) => {
    let settled = false
    const done = (reachable: boolean) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(reachable)
    }
    const socket = createConnection({ host, port })
    socket.setTimeout(timeoutMs)
    socket.once("connect", () => done(true))
    socket.once("timeout", () => done(false))
    socket.once("error", () => done(false))
  })
}
