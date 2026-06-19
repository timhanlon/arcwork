import { useState } from "react"
import type { Work, WorkCreateInput, WorkPriority, WorkReviseInput, WorkStatus } from "../../../shared/work.js"
import { rpc } from "../rpc-client.js"
import { errorMessage } from "./utils.js"

export interface UseWorkPaneMutationsOptions {
  readonly reload: () => void
  readonly chatId?: string
  readonly onCreated?: (work: Work) => void
}

export function useWorkPaneMutations({ reload, chatId, onCreated }: UseWorkPaneMutationsOptions): {
  readonly busy: boolean
  readonly error: string | undefined
  readonly setError: (error: string | undefined) => void
  readonly create: (input: WorkCreateInput) => Promise<void>
  readonly changeStatus: (id: string, status: WorkStatus) => void
  readonly changePriority: (id: string, priority: WorkPriority) => void
  readonly revise: (id: string, edits: WorkReviseInput) => void
} {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)

  const runMutation = async (effect: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setError(undefined)
    try {
      await effect()
      reload()
      return true
    } catch (e) {
      setError(errorMessage(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const create = async (input: WorkCreateInput): Promise<void> => {
    setBusy(true)
    setError(undefined)
    try {
      const made = await rpc("CreateWork", { input, chatId })
      reload()
      onCreated?.(made)
    } catch (e) {
      setError(errorMessage(e))
    } finally {
      setBusy(false)
    }
  }

  const changeStatus = (id: string, status: WorkStatus): void => {
    void runMutation(() => rpc("UpdateWorkStatus", { id, status }))
  }

  const changePriority = (id: string, priority: WorkPriority): void => {
    void runMutation(() => rpc("UpdateWorkPriority", { id, priority }))
  }

  const revise = (id: string, edits: WorkReviseInput): void => {
    void runMutation(() => rpc("ReviseWork", { id, edits }))
  }

  return { busy, error, setError, create, changeStatus, changePriority, revise }
}
