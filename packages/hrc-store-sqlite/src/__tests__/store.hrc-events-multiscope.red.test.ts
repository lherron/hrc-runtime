import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleMonitorFilters } from '../index'
import { openHrcDatabase } from '../index'

const TASK_ID = 'T-06515'
const COORD_SCOPE = `agent:coordinator:project:hrc-runtime:task:${TASK_ID}:role:coordinator`
const WORKER_SCOPE = `agent:worker:project:hrc-runtime:task:${TASK_ID}:role:tester`
const OTHER_SCOPE = 'agent:worker:project:hrc-runtime:task:T-99999:role:tester'

let tempDir: string
let databasePath: string

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-events-multiscope-red-'))
  databasePath = join(tempDir, 'state.sqlite')
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function seed(scopeRefs: string[]): ReturnType<typeof openHrcDatabase> {
  const db = openHrcDatabase(databasePath)
  for (const [index, scopeRef] of scopeRefs.entries()) {
    const hostSessionId = `host-${index}`
    const now = `2026-07-17T15:00:0${index}.000Z`
    db.sessions.insert({
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.hrcEvents.append({
      ts: now,
      category: 'turn',
      eventKind: 'turn.started',
      hostSessionId,
      scopeRef,
      laneRef: 'main',
      generation: 1,
      payload: {},
    })
  }
  return db
}

function scopesFor(filters: HrcLifecycleMonitorFilters): string[] {
  const db = seed([COORD_SCOPE, WORKER_SCOPE, OTHER_SCOPE])
  try {
    return db.hrcEvents.listFromHrcSeqFiltered(1, filters).map((event) => event.scopeRef)
  } finally {
    db.close()
  }
}

describe('T-06515 listFromHrcSeqFiltered scope sets', () => {
  test('matches an exact scopeRef set and excludes a non-member', () => {
    const filters = { scopeRefs: [COORD_SCOPE, WORKER_SCOPE] } as HrcLifecycleMonitorFilters

    expect(scopesFor(filters)).toEqual([COORD_SCOPE, WORKER_SCOPE])
  })

  test('matches each trailing-star scope prefix with SQL prefix semantics', () => {
    const filters = {
      scopeRefPrefixes: [`agent:worker:project:hrc-runtime:task:${TASK_ID}:`],
    } as HrcLifecycleMonitorFilters

    expect(scopesFor(filters)).toEqual([WORKER_SCOPE])
  })

  test('matches a complete task segment and rejects partial or different task ids', () => {
    const matching = { taskIds: [TASK_ID] } as HrcLifecycleMonitorFilters
    const nonMatching = { taskIds: ['T-0651', 'T-99998'] } as HrcLifecycleMonitorFilters

    expect(scopesFor(matching)).toEqual([COORD_SCOPE, WORKER_SCOPE])
    expect(scopesFor(nonMatching)).toEqual([])
  })
})
