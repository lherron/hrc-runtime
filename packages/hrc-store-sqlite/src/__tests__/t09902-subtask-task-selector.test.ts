import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcLifecycleMonitorFilters } from '../index'
import { openHrcDatabase } from '../index'

// Named subtasks, *Events: a task selector covers its subtasks* (T-09902).
const OWNER = 'agent:clod:project:hrc-runtime:task:T-12345'
const OWNER_ROLE = 'agent:clod:project:hrc-runtime:task:T-12345:role:tester'
const SUBTASK = 'agent:clod:project:hrc-runtime:task:T-12345.probe'
const SUBTASK_ROLE = 'agent:clod:project:hrc-runtime:task:T-12345.probe:role:tester'
const OTHER_SUBTASK = 'agent:clod:project:hrc-runtime:task:T-12345.other-one'
const LONGER_ID = 'agent:clod:project:hrc-runtime:task:T-123456'
const PREFIX_ID = 'agent:clod:project:hrc-runtime:task:T-1234'
const LIKE_DECOY = 'agent:clod:project:hrc-runtime:task:T-12345Xprobe'
const ALL = [
  OWNER,
  OWNER_ROLE,
  SUBTASK,
  SUBTASK_ROLE,
  OTHER_SUBTASK,
  LONGER_ID,
  PREFIX_ID,
  LIKE_DECOY,
]

let tempDir: string
let ordinal = 0

beforeEach(async () => {
  tempDir = await mkdtemp(join(tmpdir(), 'hrc-t09902-'))
})

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true })
})

function scopesFor(filters: HrcLifecycleMonitorFilters): string[] {
  const db = openHrcDatabase(join(tempDir, `state-${ordinal++}.sqlite`))
  try {
    for (const [index, scopeRef] of ALL.entries()) {
      db.hrcEvents.append({
        ts: `2026-09-30T15:00:0${index}.000Z`,
        category: 'turn',
        eventKind: 'turn.started',
        hostSessionId: `host-${index}`,
        scopeRef,
        laneRef: 'main',
        generation: 1,
        payload: {},
      })
    }
    return db.hrcEvents.listFromHrcSeqFiltered(1, filters).map((event) => event.scopeRef)
  } finally {
    db.close()
  }
}

describe('T-09902 task selectors cover subtask seats', () => {
  test('an ordinary task selector matches the owner and every subtask', () => {
    expect(scopesFor({ taskIds: ['T-12345'] })).toEqual([
      OWNER,
      OWNER_ROLE,
      SUBTASK,
      SUBTASK_ROLE,
      OTHER_SUBTASK,
    ])
  })

  test('a subtask selector matches only that subtask', () => {
    expect(scopesFor({ taskIds: ['T-12345.probe'] })).toEqual([SUBTASK, SUBTASK_ROLE])
  })

  test('T-1234 does not match T-12345 or its subtasks', () => {
    expect(scopesFor({ taskIds: ['T-1234'] })).toEqual([PREFIX_ID])
  })

  test('exact task ids exclude subtasks (state predicates stay exact)', () => {
    expect(scopesFor({ exactTaskIds: ['T-12345'] })).toEqual([OWNER, OWNER_ROLE])
  })
})
