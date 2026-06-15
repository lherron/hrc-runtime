import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { Database } from 'bun:sqlite'
import type { HrcLifecycleEvent } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index'
import type { HrcServer } from '../index'
import { createHrcTestFixture } from './fixtures/hrc-test-fixture'
import type { HrcServerTestFixture } from './fixtures/hrc-test-fixture'

// T-04423: operator-reap terminate stamps durable intent + attribution on the
// `runtime.terminated` audit event (the authoritative record), preserves
// continuation, and is idempotent on the terminal audit/state effects.

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-terminate-reap-')
  server = await createHrcServer(fixture.serverOpts())
})

afterEach(async () => {
  if (server) await server.stop()
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

function readContinuationJson(hostSessionId: string): string | null {
  const db = new Database(fixture.dbPath)
  try {
    return (
      db
        .query<{ continuation_json: string | null }, [string]>(
          'SELECT continuation_json FROM sessions WHERE host_session_id = ?'
        )
        .get(hostSessionId)?.continuation_json ?? null
    )
  } finally {
    db.close()
  }
}

function listTerminatedEvents(runtimeId: string): HrcLifecycleEvent[] {
  const db = openHrcDatabase(fixture.dbPath)
  try {
    return db.hrcEvents
      .listFromHrcSeq(1)
      .filter((event) => event.eventKind === 'runtime.terminated' && event.runtimeId === runtimeId)
  } finally {
    db.close()
  }
}

describe('POST /v1/terminate operator reap', () => {
  it('stamps reason + source on the runtime.terminated audit event and preserves continuation', async () => {
    fixture.seedSession('hsid-reap', 'reap-scope')
    fixture.seedTmuxRuntime('hsid-reap', 'reap-scope', 'rt-reap', { status: 'ready' })
    seedContinuation('hsid-reap', 'continuation-reap')

    const res = await fixture.postJson('/v1/terminate', {
      runtimeId: 'rt-reap',
      dropContinuation: false,
      reason: 'operator_reap',
      source: 'close-headless-ghostmux',
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      ok: true,
      runtimeId: 'rt-reap',
      droppedContinuation: false,
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      expect(db.runtimes.getByRuntimeId('rt-reap')?.status).toBe('terminated')
    } finally {
      db.close()
    }

    const events = listTerminatedEvents('rt-reap')
    expect(events).toHaveLength(1)
    expect(events[0]?.payload).toMatchObject({
      transport: 'tmux',
      droppedContinuation: false,
      reason: 'operator_reap',
      source: 'close-headless-ghostmux',
    })

    // Continuation preserved (the next turn resumes the session).
    expect(readContinuationJson('hsid-reap')).not.toBeNull()
  })

  it('is idempotent on terminal audit/state effects: a second reap emits no second event', async () => {
    fixture.seedSession('hsid-reap2', 'reap-scope-2')
    fixture.seedTmuxRuntime('hsid-reap2', 'reap-scope-2', 'rt-reap2', { status: 'ready' })

    const first = await fixture.postJson('/v1/terminate', {
      runtimeId: 'rt-reap2',
      dropContinuation: false,
      reason: 'operator_reap',
      source: 'close-headless-ghostmux',
    })
    expect(first.status).toBe(200)

    const second = await fixture.postJson('/v1/terminate', {
      runtimeId: 'rt-reap2',
      dropContinuation: false,
      reason: 'operator_reap',
      source: 'close-headless-ghostmux',
    })
    // The invariant is terminal audit/state idempotency, NOT HTTP response-shape
    // parity (daedalus #7535). At the HTTP layer the already-`terminated` runtime
    // is rejected up front (requireRuntime -> 503 RUNTIME_UNAVAILABLE), so the
    // second call cannot re-run teardown, re-mutate runs, or append a second
    // audit event. (terminateTmuxRuntime also carries an in-handler guard for
    // direct internal callers that bypass requireRuntime.)
    expect(second.status).toBe(503)

    // Exactly one terminal audit event regardless of the repeated request.
    expect(listTerminatedEvents('rt-reap2')).toHaveLength(1)
  })

  it('rejects a non-string reason', async () => {
    fixture.seedSession('hsid-reap3', 'reap-scope-3')
    fixture.seedTmuxRuntime('hsid-reap3', 'reap-scope-3', 'rt-reap3', { status: 'ready' })

    const res = await fixture.postJson('/v1/terminate', {
      runtimeId: 'rt-reap3',
      reason: 42,
    })
    expect(res.status).toBe(400)
  })
})
