import { Effect, type Scope } from "effect"
import type { AppServerCapability } from "../../../../shared/provider.js"
import { IngestStore } from "../../db/store.js"
import {
  type AppServerDriver,
  AppServerDriverError,
  type AppServerLaunchParams,
} from "../app-server-driver.js"
import { makeCodexAppServerDriver } from "./driver.js"

/**
 * Launch a codex app-server driver from a provider's {@link AppServerCapability}
 * and persist each completed turn's cumulative rows into the shared
 * {@link IngestStore}. The rows and the store are the same ones the rollout-file
 * provider writes, so a live-driven session and a scraped session are
 * indistinguishable downstream — one store, one projection. This is the reader
 * of the `ProviderSpec.appServer` capability.
 *
 * Returns the driver with a `runTurn` that also persists; `pendingApprovals` /
 * `answerApproval` are unchanged (the UI answers the pending-input signal).
 */
export const launchCodexAppServerSession = (
  capability: AppServerCapability,
  params: AppServerLaunchParams,
): Effect.Effect<AppServerDriver, AppServerDriverError, Scope.Scope | IngestStore> =>
  Effect.gen(function* () {
    const store = yield* IngestStore
    const driver = yield* makeCodexAppServerDriver({
      command: capability.launchCmd,
      args: [...capability.args],
      cwd: params.cwd,
      model: params.model,
      sandbox: params.sandbox,
      approvalPolicy: params.approvalPolicy,
      env: params.env,
      clientName: params.clientName,
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
