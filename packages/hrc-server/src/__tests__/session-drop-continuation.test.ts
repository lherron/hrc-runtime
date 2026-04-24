import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type { DropContinuationResponse, HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-session-drop-continuation-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) {
    await server.stop()
  }
  await fixture.cleanup()
})

function seedContinuation(hostSessionId: string, key: string): void {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    db.sessions.updateContinuation(hostSessionId, { provider: 'anthropic', key }, fixture.now())
  } finally {
    db.close()
  }
}

function readSession(hostSessionId: string): {
  generation: number
  continuation_json: string | null
} {
  const db = new Database(fixture.dbPath)
  try {
    const row = db
      .query<{ generation: number; continuation_json: string | null }, [string]>(
        'SELECT generation, continuation_json FROM sessions WHERE host_session_id = ?'
      )
      .get(hostSessionId)
    if (!row) {
      throw new Error(`missing session ${hostSessionId}`)
    }
    return row
  } finally {
    db.close()
  }
}

function listContinuationDroppedEvents(hostSessionId: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listFromHrcSeq(1)
      .filter(
        (event) =>
          event.eventKind === 'session.continuation_dropped' &&
          event.hostSessionId === hostSessionId
      )
  } finally {
    db.close()
  }
}

async function dropContinuation(
  hostSessionId: string,
  reason?: string
): Promise<DropContinuationResponse> {
  const res = await fixture.postJson('/v1/sessions/drop-continuation', {
    hostSessionId,
    ...(reason !== undefined ? { reason } : {}),
  })
  expect(res.status).toBe(200)
  return (await res.json()) as DropContinuationResponse
}

describe('POST /v1/sessions/drop-continuation', () => {
  it('drops a non-null continuation and emits one event with previousContinuationKey', async () => {
    fixture.seedSession('hsid-drop-continuation', 'drop-continuation')
    seedContinuation('hsid-drop-continuation', 'cont-before-drop')

    const body = await dropContinuation('hsid-drop-continuation')

    expect(body).toMatchObject({
      ok: true,
      hostSessionId: 'hsid-drop-continuation',
      dropped: true,
      previousContinuationKey: 'cont-before-drop',
    })
    expect(readSession('hsid-drop-continuation').continuation_json).toBeNull()

    const events = listContinuationDroppedEvents('hsid-drop-continuation')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      hostSessionId: 'hsid-drop-continuation',
      previousContinuationKey: 'cont-before-drop',
    })
  })

  it('is idempotent for an already-null continuation and emits no event', async () => {
    fixture.seedSession('hsid-drop-null', 'drop-null')

    const body = await dropContinuation('hsid-drop-null')

    expect(body).toMatchObject({
      ok: true,
      hostSessionId: 'hsid-drop-null',
      dropped: false,
      previousContinuationKey: null,
    })
    expect(readSession('hsid-drop-null').continuation_json).toBeNull()
    expect(listContinuationDroppedEvents('hsid-drop-null')).toHaveLength(0)
  })

  it('does not change the session generation field', async () => {
    fixture.seedSession('hsid-drop-generation', 'drop-generation')
    seedContinuation('hsid-drop-generation', 'cont-generation')
    const before = readSession('hsid-drop-generation')

    await dropContinuation('hsid-drop-generation')

    const after = readSession('hsid-drop-generation')
    expect(after.generation).toBe(before.generation)
    expect(after.continuation_json).toBeNull()
  })

  it('copies the optional reason into the continuation_dropped event payload', async () => {
    fixture.seedSession('hsid-drop-reason', 'drop-reason')
    seedContinuation('hsid-drop-reason', 'cont-reason')

    await dropContinuation('hsid-drop-reason', 'operator requested reset')

    const events = listContinuationDroppedEvents('hsid-drop-reason')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      hostSessionId: 'hsid-drop-reason',
      previousContinuationKey: 'cont-reason',
      reason: 'operator requested reset',
    })
  })
})
