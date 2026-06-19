import { describe, expect, it } from "@effect/vitest"
import { Effect, Exit, Ref } from "effect"
import type { HookSignal } from "../src/main/hooks/signals.js"
import { ingestHookSignal } from "../src/main/services/HookSignalIngestion.js"

// The function forwards an opaque signal to each projection and never inspects
// it, so a sentinel stands in for any parsed HookSignal.
const signal = { sentinel: true } as unknown as HookSignal

describe("ingestHookSignal", () => {
  it.effect("persists the raw signal before either projection and surfaces each insert count", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (step: string) => Ref.update(order, (steps) => [...steps, step])

      const result = yield* ingestHookSignal(
        {
          raw: { ingestSignal: () => record("raw").pipe(Effect.as(true)) },
          activity: { ingestSignal: () => record("activity").pipe(Effect.as(2)) },
          chat: { ingestSignal: () => record("chat").pipe(Effect.as(3)) },
        },
        signal,
      )

      // Raw is durable before any projection runs; ordering is the product contract.
      expect(yield* Ref.get(order)).toEqual(["raw", "activity", "chat"])
      // Each projection's count is reported back, not dropped.
      expect(result).toEqual({ rawInserted: true, activityInserted: 2, chatInserted: 3 })
    }),
  )

  it.effect("isolates raw persistence from a failing downstream projection", () =>
    Effect.gen(function* () {
      const order = yield* Ref.make<ReadonlyArray<string>>([])
      const record = (step: string) => Ref.update(order, (steps) => [...steps, step])

      const exit = yield* ingestHookSignal(
        {
          raw: { ingestSignal: () => record("raw").pipe(Effect.as(true)) },
          // A real projection can throw a defect; raw has already committed by then.
          activity: { ingestSignal: () => record("activity").pipe(Effect.flatMap(() => Effect.die("boom"))) },
          chat: { ingestSignal: () => record("chat").pipe(Effect.as(0)) },
        },
        signal,
      ).pipe(Effect.exit)

      expect(Exit.isFailure(exit)).toBe(true)
      // Raw ran (and would have committed) before the projection blew up; chat never ran.
      expect(yield* Ref.get(order)).toEqual(["raw", "activity"])
    }),
  )
})
