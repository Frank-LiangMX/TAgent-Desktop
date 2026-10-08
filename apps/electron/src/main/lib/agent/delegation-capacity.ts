import { readAgentCrewPrefs } from './agent-crew-prefs'

/** One parent-owned budget shared by foreground tasks, background tasks and crew boards. */
const slots = new Map<string, Map<string, symbol>>()

export function countDelegationSlots(parentSessionId: string): number {
  return slots.get(parentSessionId)?.size ?? 0
}

/** Synchronous reservation; cancellation does not release until execution really settles. */
export function tryReserveDelegationSlot(parentSessionId: string, taskId: string): (() => void) | null {
  const cap = readAgentCrewPrefs().maxParallelWorkers
  const active = slots.get(parentSessionId) ?? new Map<string, symbol>()
  if (active.has(taskId) || active.size >= cap) return null
  const token = Symbol(taskId)
  active.set(taskId, token)
  slots.set(parentSessionId, active)
  return () => {
    const current = slots.get(parentSessionId)
    if (current?.get(taskId) !== token) return
    current.delete(taskId)
    if (!current.size) slots.delete(parentSessionId)
  }
}
