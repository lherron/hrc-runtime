import { BUSY_BACKOFF_BASE_MILLIS, BUSY_BACKOFF_MAX_MILLIS, MAX_PAUSE_MILLIS } from './constants.ts'
import type { PrunePhaseStop, PruneStateRetentionOptions } from './types.ts'

/**
 * Shared wall-clock and yield accounting for one prune run. Every write step
 * consults it before taking the lock and pays back into it afterwards.
 */
export type WriteBudget = {
  startedAtMillis: number
  deadlineAtMillis: number | null
  paceMillis: number
  maxWriteHoldMillis: number
  maxDutyCycle: number
  busyMaxRetries: number
  pausedMillis: number
  busyRetries: number
  writeSteps: number
  heldMillis: number
  maxObservedWriteHoldMillis: number
  deadlineExceeded: boolean
}

export function createWriteBudget(options: PruneStateRetentionOptions): WriteBudget {
  const startedAtMillis = Date.now()
  return {
    startedAtMillis,
    deadlineAtMillis: options.deadlineMillis > 0 ? startedAtMillis + options.deadlineMillis : null,
    paceMillis: options.paceMillis,
    maxWriteHoldMillis: options.maxWriteHoldMillis,
    maxDutyCycle: options.maxDutyCycle,
    busyMaxRetries: options.busyMaxRetries,
    pausedMillis: 0,
    busyRetries: 0,
    writeSteps: 0,
    heldMillis: 0,
    maxObservedWriteHoldMillis: 0,
    deadlineExceeded: false,
  }
}

export function deadlineReached(budget: WriteBudget): boolean {
  if (budget.deadlineAtMillis === null) {
    return false
  }
  if (Date.now() < budget.deadlineAtMillis) {
    return false
  }
  budget.deadlineExceeded = true
  return true
}

/**
 * Yield the writer lock long enough to keep this job's share of wall-clock time
 * at or under the duty-cycle budget, so the daemon mostly finds the lock free.
 */
export async function pauseAfterWrite(budget: WriteBudget, holdMillis: number): Promise<void> {
  const dutyPause = holdMillis * (1 / budget.maxDutyCycle - 1)
  const pause = Math.min(MAX_PAUSE_MILLIS, Math.max(budget.paceMillis, dutyPause))
  if (pause <= 0) {
    return
  }
  budget.pausedMillis += pause
  await Bun.sleep(pause)
}

export function isBusyError(error: unknown): boolean {
  const code = typeof error === 'object' && error !== null ? String(Reflect.get(error, 'code')) : ''
  const message = error instanceof Error ? error.message : String(error)
  return /SQLITE_BUSY/i.test(code) || /SQLITE_BUSY|database (?:table )?is locked/i.test(message)
}

/**
 * Run one write step, backing off instead of spinning when the daemon holds the
 * lock. Exhausting the ladder throws the underlying busy error; callers turn
 * that into a clean partial exit rather than a crash.
 */
export async function runWriteStep<T>(
  budget: WriteBudget,
  action: () => T
): Promise<{ value: T; holdMillis: number }> {
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now()
    try {
      const value = action()
      const holdMillis = Date.now() - startedAt
      budget.writeSteps += 1
      budget.heldMillis += holdMillis
      budget.maxObservedWriteHoldMillis = Math.max(budget.maxObservedWriteHoldMillis, holdMillis)
      return { value, holdMillis }
    } catch (error) {
      if (!isBusyError(error) || attempt >= budget.busyMaxRetries) {
        throw error
      }
      budget.busyRetries += 1
      const backoff = Math.min(BUSY_BACKOFF_MAX_MILLIS, BUSY_BACKOFF_BASE_MILLIS * 2 ** attempt)
      budget.pausedMillis += backoff
      await Bun.sleep(backoff)
    }
  }
}

/**
 * Contention on a read is the daemon working, not a prune failure. Degrade to a
 * fallback and let the caller report it rather than aborting the run.
 */
export function tolerateBusy<T>(action: () => T, fallback: T): { value: T; busy: boolean } {
  try {
    return { value: action(), busy: false }
  } catch (error) {
    if (!isBusyError(error)) {
      throw error
    }
    return { value: fallback, busy: true }
  }
}

export function sumOrNull(counts: Array<number | null>): number | null {
  return counts.some((count) => count === null)
    ? null
    : counts.reduce<number>((sum, count) => sum + (count ?? 0), 0)
}

/**
 * A skipped table is a configuration choice, not an interruption, so it never
 * downgrades the run's outcome.
 */
export function worstStopReason(reasons: PrunePhaseStop[]): PrunePhaseStop {
  if (reasons.includes('deadline')) {
    return 'deadline'
  }
  if (reasons.includes('busy')) {
    return 'busy'
  }
  return 'complete'
}
