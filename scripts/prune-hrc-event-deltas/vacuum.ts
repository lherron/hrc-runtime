import type { Database } from 'bun:sqlite'

import {
  MAX_INCREMENTAL_VACUUM_CHUNK_PAGES,
  MIN_INCREMENTAL_VACUUM_CHUNK_PAGES,
} from './constants.ts'
import type { PrunePhaseStop } from './types.ts'
import {
  type WriteBudget,
  deadlineReached,
  isBusyError,
  pauseAfterWrite,
  runWriteStep,
  tolerateBusy,
} from './write-budget.ts'

export function readPragmaNumber(db: Database, pragma: 'auto_vacuum' | 'freelist_count'): number {
  const row = db.query<Record<string, number>, []>(`PRAGMA ${pragma}`).get()
  return row ? (Object.values(row)[0] ?? 0) : 0
}

export function assertIncrementalAutoVacuum(mode: number): void {
  if (mode !== 2) {
    throw new Error(
      `state.sqlite auto_vacuum mode is ${mode}, expected 2 (INCREMENTAL); refusing to delete rows until a coordinated full VACUUM has installed the pointer map`
    )
  }
}

/**
 * Size the next write step from how long the last one held the lock. Work cost
 * per unit varies with row size, cache state, and database size, so no fixed
 * step size stays safe as the database grows — the measured hold does.
 */
export function adaptStepSize(
  requested: number,
  holdMillis: number,
  targetMillis: number,
  minimum: number,
  maximum: number
): number {
  const clamp = (value: number): number => Math.min(maximum, Math.max(minimum, Math.round(value)))
  // Holds are measured in whole milliseconds, so a step reporting 0 was merely
  // too fast to time — not free. Floor it, or a target below the clock's
  // resolution reads as headroom and the step grows when it should shrink.
  const observedMillis = Math.max(holdMillis, 0.5)
  if (observedMillis > targetMillis) {
    return clamp((requested * targetMillis) / observedMillis)
  }
  if (observedMillis * 2 < targetMillis) {
    return clamp(requested * 1.5)
  }
  return clamp(requested)
}

/**
 * Reclaim free pages in paced chunks. `PRAGMA incremental_vacuum` with no
 * argument drains the whole freelist inside a single write transaction — on a
 * multi-million-page freelist that is hours of unbroken writer lock, which is
 * exactly how this job took the daemon down. Never issue the unbounded form.
 */
export async function incrementalVacuum(
  db: Database,
  budget: WriteBudget,
  targetPages: number,
  initialChunkPages: number
): Promise<{
  reclaimedPages: number
  chunkPages: number
  stopReason: PrunePhaseStop
}> {
  const limit = targetPages === 0 ? Number.POSITIVE_INFINITY : targetPages
  let chunkPages = Math.min(
    MAX_INCREMENTAL_VACUUM_CHUNK_PAGES,
    Math.max(MIN_INCREMENTAL_VACUUM_CHUNK_PAGES, initialChunkPages)
  )
  let reclaimedPages = 0

  while (reclaimedPages < limit) {
    const before = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), 0)
    if (before.busy) {
      return { reclaimedPages, chunkPages, stopReason: 'busy' }
    }
    const freelistBefore = before.value
    if (freelistBefore === 0) {
      return { reclaimedPages, chunkPages, stopReason: 'complete' }
    }
    if (deadlineReached(budget)) {
      return { reclaimedPages, chunkPages, stopReason: 'deadline' }
    }

    const requestedPages = Math.min(chunkPages, freelistBefore, limit - reclaimedPages)
    let holdMillis: number
    try {
      const step = await runWriteStep(budget, () =>
        db.exec(`PRAGMA incremental_vacuum(${requestedPages});`)
      )
      holdMillis = step.holdMillis
    } catch (error) {
      if (!isBusyError(error)) {
        throw error
      }
      return { reclaimedPages, chunkPages, stopReason: 'busy' }
    }

    const after = tolerateBusy(() => readPragmaNumber(db, 'freelist_count'), freelistBefore)
    if (after.busy) {
      return { reclaimedPages, chunkPages, stopReason: 'busy' }
    }
    const freed = Math.max(0, freelistBefore - after.value)
    reclaimedPages += freed
    if (freed === 0) {
      return { reclaimedPages, chunkPages, stopReason: 'complete' }
    }
    chunkPages = adaptStepSize(
      requestedPages,
      holdMillis,
      budget.maxWriteHoldMillis,
      MIN_INCREMENTAL_VACUUM_CHUNK_PAGES,
      MAX_INCREMENTAL_VACUUM_CHUNK_PAGES
    )
    await pauseAfterWrite(budget, holdMillis)
  }

  return { reclaimedPages, chunkPages, stopReason: 'complete' }
}
