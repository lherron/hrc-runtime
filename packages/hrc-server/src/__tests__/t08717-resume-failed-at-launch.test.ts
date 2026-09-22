/**
 * T-08717 — a resumed continuation whose harness dies before confirming it is
 * dropped, so the next automatic birth is fresh instead of resuming a session
 * the provider no longer has (muse: "retained session not found").
 *
 * Failure modes this guards, written before the code:
 *  1. A healthy resume (claude/codex emit `continuation.updated` right after
 *     ready) that later crashes loses its continuation. → must NOT drop.
 *  2. A resume that ran a turn and then crashed loses its continuation.
 *     → must NOT drop.
 *  3. A fresh launch (no continuation in the frozen spec) that dies drops an
 *     unrelated stored continuation. → must NOT drop.
 *  4. The session already moved to a different continuation (a newer birth
 *     minted one); the stale launch's death drops the new one. → must NOT drop.
 *  5. A start failure and the close observer both fire for one invocation and
 *     record two drops. → exactly one `session.continuation_dropped`.
 *  6. The dead resume still leaves the key reusable, so the next birth resumes
 *     it again. → reuse disabled after the drop.
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase } from 'hrc-store-sqlite'

import {
  automaticContinuationForSession,
  dropUnconfirmedResumeContinuation,
} from '../session-continuation-reuse.js'

const HSID = 'hsid-t08717'
const SCOPE = 'agent:muse:project:hrc-runtime:task:primary'
const NOW = '2026-09-22T17:00:00.000Z'
const STALE_KEY = 'muse-session-missing'

let dir: string
let db: HrcDatabase

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'hrc-t08717-'))
  db = openHrcDatabase(join(dir, 'state.sqlite'))
  db.sessions.insert({
    hostSessionId: HSID,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 4,
    status: 'active',
    createdAt: NOW,
    updatedAt: NOW,
    ancestorScopeRefs: [],
  })
  db.sessions.updateContinuation(HSID, { provider: 'muse', kind: 'session', key: STALE_KEY }, NOW)
})

afterEach(async () => {
  db.close()
  await rm(dir, { recursive: true, force: true })
})

/** Seed one launched invocation whose frozen spec carried `continuation`. */
function seedLaunch(
  id: string,
  continuation: { provider: string; kind: string; key: string } | undefined,
  eventTypes: string[] = []
): string {
  const runtimeId = `rt-${id}`
  const invocationId = `inv-${id}`
  const operationId = `op-${id}`
  db.runtimes.insert({
    runtimeId,
    hostSessionId: HSID,
    scopeRef: SCOPE,
    laneRef: 'main',
    generation: 4,
    transport: 'tmux',
    harness: 'muse',
    provider: 'muse',
    status: 'ready',
    supportsInflightInput: false,
    adopted: false,
    controllerKind: 'harness-broker',
    activeInvocationId: invocationId,
    lastActivityAt: NOW,
    createdAt: NOW,
    updatedAt: NOW,
  })
  db.runtimeOperations.insert({
    operationId,
    runtimeId,
    hostSessionId: HSID,
    generation: 4,
    operationKind: 'broker_invocation',
    controller: 'harness-broker',
    startupMethod: 'aspd',
    status: 'running',
    routeDecisionJson: '{}',
    createdAt: NOW,
    updatedAt: NOW,
    preparationJson: JSON.stringify({
      admission: {
        execution: {
          dispatchRequest: {
            startRequest: { spec: continuation === undefined ? {} : { continuation } },
          },
        },
      },
    }),
  })
  db.brokerInvocations.insert({
    invocationId,
    operationId,
    runtimeId,
    brokerProtocol: 'harness-broker/0.2',
    brokerDriver: 'muse-cli-tmux',
    invocationState: 'ready',
    capabilitiesJson: '{}',
    specHash: 'spec',
    startRequestHash: 'sr',
    selectedProfileHash: 'pf',
    createdAt: NOW,
    updatedAt: NOW,
  })
  const types = ['invocation.started', 'invocation.ready', ...eventTypes]
  types.forEach((type, index) => {
    db.sqlite
      .query(
        `INSERT INTO broker_invocation_events
           (invocation_id, seq, time, type, runtime_id, broker_event_json, projection_status, created_at)
         VALUES (?, ?, ?, ?, ?, '{}', 'projected', ?)`
      )
      .run(invocationId, index + 1, NOW, type, runtimeId, NOW)
  })
  return invocationId
}

function droppedEventCount(): number {
  return db.hrcEvents
    .listByKind('session.continuation_dropped', { hostSessionId: HSID })
    .filter((event) => event.hostSessionId === HSID).length
}

function session() {
  const row = db.sessions.getByHostSessionId(HSID)
  if (row === null) throw new Error('missing session')
  return row
}

const MUSE_STALE = { provider: 'muse', kind: 'session', key: STALE_KEY }

describe('T-08717 dropUnconfirmedResumeContinuation', () => {
  it('drops a resumed continuation whose harness died before confirming it (6)', () => {
    const invocationId = seedLaunch('dead', MUSE_STALE)

    const result = dropUnconfirmedResumeContinuation(db, {
      invocationId,
      stage: 'crash',
      failure: 'Broker socket closed unexpectedly',
    })

    expect(result?.dropped).toBe(true)
    expect(result?.message).toBe(
      `resume of muse continuation ${STALE_KEY} failed at launch; dropped it so the next birth is fresh`
    )
    expect(automaticContinuationForSession(db, session())).toBeUndefined()
    expect(droppedEventCount()).toBe(1)
  })

  it('keeps a resume the harness confirmed with continuation.updated (1)', () => {
    const invocationId = seedLaunch('confirmed', MUSE_STALE, ['continuation.updated'])

    expect(
      dropUnconfirmedResumeContinuation(db, { invocationId, stage: 'crash', failure: 'x' })
    ).toBeUndefined()
    expect(automaticContinuationForSession(db, session())?.key).toBe(STALE_KEY)
  })

  it('keeps a resume that started a turn before crashing (2)', () => {
    const invocationId = seedLaunch('turned', MUSE_STALE, ['turn.started'])

    expect(
      dropUnconfirmedResumeContinuation(db, { invocationId, stage: 'crash', failure: 'x' })
    ).toBeUndefined()
    expect(automaticContinuationForSession(db, session())?.key).toBe(STALE_KEY)
  })

  it('ignores a fresh launch that carried no continuation (3)', () => {
    const invocationId = seedLaunch('fresh', undefined)

    expect(
      dropUnconfirmedResumeContinuation(db, { invocationId, stage: 'start', failure: 'x' })
    ).toBeUndefined()
    expect(automaticContinuationForSession(db, session())?.key).toBe(STALE_KEY)
  })

  it('never drops a newer continuation the session moved to (4)', () => {
    const invocationId = seedLaunch('superseded', MUSE_STALE)
    db.sessions.updateContinuation(HSID, { provider: 'muse', kind: 'session', key: 'newer' }, NOW)

    const result = dropUnconfirmedResumeContinuation(db, {
      invocationId,
      stage: 'crash',
      failure: 'x',
    })

    expect(result?.dropped).toBe(false)
    expect(automaticContinuationForSession(db, session())?.key).toBe('newer')
    expect(droppedEventCount()).toBe(0)
  })

  it('records one drop when start failure and close observer both fire (5)', () => {
    const invocationId = seedLaunch('both', MUSE_STALE)

    const first = dropUnconfirmedResumeContinuation(db, {
      invocationId,
      stage: 'start',
      failure: "can't find pane: %1",
    })
    const second = dropUnconfirmedResumeContinuation(db, {
      invocationId,
      stage: 'crash',
      failure: 'Broker socket closed unexpectedly',
    })

    expect(first?.dropped).toBe(true)
    expect(second?.dropped).toBe(false)
    expect(second?.message).toContain('already dropped')
    expect(droppedEventCount()).toBe(1)
  })
})
