import { useMemo } from "react"
import { useAtomValue } from "@effect/atom-react"
import * as AsyncResult from "effect/unstable/reactivity/AsyncResult"
import type { Chat } from "../../../shared/chat.js"
import type { TargetId } from "../../../shared/ids.js"
import type { TargetSession } from "../../../shared/instance.js"
import type { LiveTargetActivity } from "../../../shared/live-target-state.js"
import type { Workspace } from "../../../shared/workspace.js"
import { liveTargetStatesAtom, pendingRequestsAtom } from "../atoms.js"
import { REQUEST_SLOTS } from "../shell/keybindings.js"
import { orderedPendingSessionIds, type LiveStateById } from "./grouping.js"

export interface SessionActivityProjection {
  readonly liveStateById: LiveStateById
  readonly pendingSessionIds: ReadonlySet<string>
  readonly pendingOrder: ReadonlyArray<TargetId>
  readonly requestSlots: ReadonlyMap<string, number>
}

export function useSessionActivityProjection({
  workspaces,
  chats,
  sessions,
}: {
  readonly workspaces: ReadonlyArray<Workspace>
  readonly chats: ReadonlyArray<Chat>
  readonly sessions: ReadonlyArray<TargetSession>
}): SessionActivityProjection {
  const pendingRequestsResult = useAtomValue(pendingRequestsAtom)
  const pendingRequests = useMemo(
    () => (AsyncResult.isSuccess(pendingRequestsResult) ? pendingRequestsResult.value : []),
    [pendingRequestsResult],
  )
  const pendingSessionIds = useMemo(
    () => new Set(pendingRequests.map((request) => request.targetSessionId)),
    [pendingRequests],
  )

  const liveTargetStatesResult = useAtomValue(liveTargetStatesAtom)
  const liveTargetStates = useMemo(
    () => (AsyncResult.isSuccess(liveTargetStatesResult) ? liveTargetStatesResult.value : []),
    [liveTargetStatesResult],
  )
  const liveStateById = useMemo(
    () => new Map<string, LiveTargetActivity>(liveTargetStates.map((s) => [s.targetSessionId, s.activity])),
    [liveTargetStates],
  )

  const pendingOrder = useMemo(
    () =>
      orderedPendingSessionIds(workspaces, chats, sessions, pendingSessionIds).slice(
        0,
        REQUEST_SLOTS.length,
      ),
    [workspaces, chats, sessions, pendingSessionIds],
  )
  const requestSlots = useMemo(() => {
    const map = new Map<string, number>()
    pendingOrder.forEach((sessionId, index) => map.set(sessionId, index + 1))
    return map
  }, [pendingOrder])

  return { liveStateById, pendingSessionIds, pendingOrder, requestSlots }
}
