import type { HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHostSessionId, timestamp } from './server-util.js'

export function createSessionSuccessorFromContinuation(
  db: HrcDatabase,
  prior: HrcSessionRecord,
  overrides: {
    generation?: number | undefined
    lastAppliedIntentJson?: HrcSessionRecord['lastAppliedIntentJson'] | undefined
  } = {}
): HrcSessionRecord {
  const now = timestamp()
  const next: HrcSessionRecord = {
    hostSessionId: createHostSessionId(),
    scopeRef: prior.scopeRef,
    laneRef: prior.laneRef,
    generation: overrides.generation ?? prior.generation + 1,
    status: 'active',
    priorHostSessionId: prior.hostSessionId,
    createdAt: now,
    updatedAt: now,
    ...((overrides.lastAppliedIntentJson ?? prior.lastAppliedIntentJson)
      ? { lastAppliedIntentJson: overrides.lastAppliedIntentJson ?? prior.lastAppliedIntentJson }
      : {}),
    ...(prior.continuation ? { continuation: prior.continuation } : {}),
  }

  db.sessions.updateStatus(prior.hostSessionId, 'archived', now)
  const created = db.sessions.insert(next)
  db.continuities.upsert({
    scopeRef: prior.scopeRef,
    laneRef: prior.laneRef,
    activeHostSessionId: created.hostSessionId,
    updatedAt: now,
  })

  return created
}
