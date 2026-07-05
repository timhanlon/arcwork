import { Effect, type Scope } from "effect"
import type { AppServerCapability } from "../../../../shared/provider.js"
import { IngestStore } from "../../db/store.js"
import { type AppServerDriver, AppServerDriverError, type AppServerLaunchParams } from "../app-server-driver.js"
import { makeCursorAcpDriver } from "./driver.js"

/**
 * Launch a Cursor ACP driver from a provider's {@link AppServerCapability} and
 * persist each completed turn's cumulative rows into the shared {@link IngestStore}
 * — the cursor sibling of `launchCodexAppServerSession`. The rows and the store
 * are the same ones the rollout-file provider writes, so a live-driven ACP session
 * and a scraped cursor session are indistinguishable downstream.
 */
export const launchCursorAcpSession = (
  capability: AppServerCapability,
  params: AppServerLaunchParams,
): Effect.Effect<AppServerDriver, AppServerDriverError, Scope.Scope | IngestStore> =>
  Effect.gen(function* () {
    const store = yield* IngestStore
    const driver = yield* makeCursorAcpDriver({
      command: capability.launchCmd,
      args: [...capability.args],
      cwd: params.cwd,
      model: params.model,
      env: params.env,
      resumeThreadId: params.resumeThreadId,
    })

    const runTurn = (text: string) =>
      driver.runTurn(text).pipe(
        Effect.tap((result) =>
          store
            .replaceSession(result.rows)
            .pipe(Effect.mapError((cause) => new AppServerDriverError({ message: "persist turn failed", cause }))),
        ),
      )

    return { ...driver, runTurn }
  })
