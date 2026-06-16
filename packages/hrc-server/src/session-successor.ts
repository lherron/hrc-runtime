import type { HrcSessionRecord } from 'hrc-core'
import type { HrcDatabase } from 'hrc-store-sqlite'

import { createHostSessionId, timestamp } from './server-util.js'

export function createSessionSuccessorFromContinuation(
  db: HrcDatabase,
  prior: HrcSessionRecord,
  overrides: {
    lastAppliedIntentJson?: HrcSessionRecord['lastAppliedIntentJson'] | undefined
    parsedScopeJson?: HrcSessionRecord['parsedScopeJson'] | undefined
  } = {}
): HrcSessionRecord {
  const now = timestamp()
  const next: HrcSessionRecord = {
    hostSessionId: createHostSessionId(),
    scopeRef: prior.scopeRef,
    laneRef: prior.laneRef,
    generation: prior.generation + 1,
    status: 'active',
    priorHostSessionId: prior.hostSessionId,
    createdAt: now,
    updatedAt: now,
    ancestorScopeRefs: prior.ancestorScopeRefs,
    ...((overrides.parsedScopeJson ?? prior.parsedScopeJson)
      ? { parsedScopeJson: overrides.parsedScopeJson ?? prior.parsedScopeJson }
      : {}),
    ...((overrides.lastAppliedIntentJson ?? prior.lastAppliedIntentJson)
      ? { lastAppliedIntentJson: overrides.lastAppliedIntentJson ?? prior.lastAppliedIntentJson }
      : {}),
    ...(prior.continuation ? { continuation: prior.continuation } : {}),
  }

  const created = db.sessions.insert(next)
  db.continuities.upsert({
    scopeRef: prior.scopeRef,
    laneRef: prior.laneRef,
    activeHostSessionId: created.hostSessionId,
    updatedAt: now,
  })

  return created
}
