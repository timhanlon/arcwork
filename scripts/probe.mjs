// CDP driver for the live dev window. Run `pnpm dev` first (it opens port 9222
// via the dev-only switch in src/main/index.ts), then:
//   node scripts/probe.mjs shot [out.png] [sel]  screenshot renderer (or clip to CSS selector, 2x)
//   node scripts/probe.mjs text             dump document.body.innerText
//   node scripts/probe.mjs click "<sel>"    click first matching element
//   node scripts/probe.mjs eval "<expr>"    evaluate JS in the page, print result
import { chromium } from "playwright"
import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"

const ENDPOINT = "http://localhost:9222"

// Hard wall-clock cap. Every path below races against this so the command can
// never wedge the terminal — the failures we've hit (occluded-window capture,
// CDP close never acking) hang *below* Playwright's own timeouts, so we need our
// own. Exits non-zero with a diagnostic instead of hanging forever.
const DEADLINE_MS = 20000
const deadline = new Promise((_, reject) =>
  setTimeout(() => reject(new Error(`probe timed out after ${DEADLINE_MS}ms`)), DEADLINE_MS).unref(),
)

async function page() {
  const browser = await chromium.connectOverCDP(ENDPOINT)
  const ctx = browser.contexts()[0]
  const p = ctx.pages().find((p) => !p.url().startsWith("devtools://")) ?? ctx.pages()[0]
  if (!p) throw new Error("no renderer page found on CDP endpoint")
  return { browser, ctx, p }
}

// Capture via a raw CDP session with `fromSurface: false`: this renders straight
// from the web contents instead of the GPU surface, so it succeeds even when the
// Electron window is occluded, minimized, or backgrounded — the exact case where
// Playwright's high-level `page.screenshot()` (fromSurface: true) blocks forever
// waiting for a compositor frame that a hidden window never produces.
// Two capture paths, because Chromium only honors a screenshot `clip` when
// rendering `fromSurface: true` (GPU surface) — the very mode that blocks on an
// occluded/hidden window. So:
//   - no selector → full renderer via raw CDP `fromSurface: false` (occlusion-proof).
//   - selector    → Playwright's element screenshot, which clips at device scale.
//     This needs the window visible; that's fine for interactive element shots.
async function shot(ctx, p, out, sel) {
  await mkdir(path.dirname(out), { recursive: true })
  if (sel) {
    const el = p.locator(sel).first()
    if ((await el.count()) === 0) throw new Error(`no element matched selector: ${sel}`)
    await el.screenshot({ path: out })
    return out
  }
  const session = await ctx.newCDPSession(p)
  const { data } = await session.send("Page.captureScreenshot", {
    format: "png",
    fromSurface: false,
    captureBeyondViewport: true,
  })
  await writeFile(out, Buffer.from(data, "base64"))
  return out
}

async function main() {
  const [cmd, arg, arg2] = process.argv.slice(2)
  const { ctx, p } = await page()
  switch (cmd) {
    case "shot":
      console.log(await shot(ctx, p, path.resolve(arg ?? ".tmp/arc.png"), arg2))
      break
    case "text":
      console.log(await p.evaluate(() => document.body.innerText))
      break
    case "click":
      await p.locator(arg).first().click()
      console.log(`clicked ${arg}`)
      break
    case "eval":
      console.log(JSON.stringify(await p.evaluate(arg), null, 2))
      break
    default:
      console.error("usage: probe.mjs <shot|text|click|eval> [arg]")
      process.exitCode = 1
  }
}

// Race the work against the deadline, then force-exit. We deliberately do NOT
// `browser.close()`: over connectOverCDP that only disconnects our client, and
// it has itself hung waiting for an ack that Electron never sends. A bare
// `process.exit` tears down the CDP socket cleanly and instantly.
try {
  await Promise.race([main(), deadline])
  process.exit(process.exitCode ?? 0)
} catch (err) {
  console.error(String(err?.message ?? err))
  process.exit(1)
}
