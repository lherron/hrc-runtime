import type { HrcContinuationRef, HrcRuntimeSnapshot, HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

/**
 * Provider keys are durable history. This helper is the ordinary-launch gate:
 * explicit clear/drop intent suppresses automatic reuse without deleting the
 * key that `hrc resume` may select later.
 */
export function automaticContinuationForSession(
  db: HrcDatabase,
  session: HrcSessionRecord
): HrcContinuationRef | undefined {
  return db.sessions.isContinuationReuseDisabled(session.hostSessionId)
    ? undefined
    : session.continuation
}

export function automaticContinuationForRuntime(
  db: HrcDatabase,
  session: HrcSessionRecord,
  runtime: HrcRuntimeSnapshot
): HrcContinuationRef | undefined {
  if (db.sessions.isContinuationReuseDisabled(session.hostSessionId)) {
    return undefined
  }
  return runtime.continuation ?? session.continuation
}
