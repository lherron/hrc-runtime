import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

/**
 * The Stop gate against the wrkq ledger (T-07612 §8, T-07615).
 *
 * The predicate moved to `wrkq.envelope.pendingView`; the caps stay in HRC
 * because a refusal count references a run. The behaviour daedalus ratified for
 * T-06810 is unchanged, and one clause matters more than the rest: it FAILS
 * OPEN, because a collaboration ledger that is down must not be able to hold
 * every agent on the fleet inside its turn.
 */

const scope = 'agent:cody:project:hrc-runtime:task:T-07615-stop'
const target = `${scope}/lane:main`
const sender = 'mable@hrc-runtime:T-07615'
const runtimeId = 'rt-mail-stop-hook'
const runId = 'run-mail-stop-hook'
const hostSessionId = 'hsid-mail-stop-hook'

let fixture: HrcServerTestFixture
let server: HrcServer
let ledger: FakeWrkqLedger

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-stop-hook-')
  ledger = new FakeWrkqLedger()
  server = await createHrcServer(
    fixture.serverOpts({ otelListenerEnabled: false, wrkqLedger: ledger })
  )
  fixture.seedSession(hostSessionId, scope)
  fixture.seedTmuxRuntime(hostSessionId, scope, runtimeId, {
    status: 'busy',
    activeRunId: runId,
  })
  const db = openHrcDatabase(fixture.dbPath)
  try {
    const now = fixture.now()
    db.runs.insert({
      runId,
      hostSessionId,
      runtimeId,
      scopeRef: scope,
      laneRef: 'default',
      generation: 1,
      transport: 'tmux',
      status: 'running',
      acceptedAt: now,
      startedAt: now,
      updatedAt: now,
    })
  } finally {
    db.close()
  }
})

afterEach(async () => {
  await server.stop()
  await fixture.cleanup()
})

/** An obligation the agent has actually been SHOWN. Only those block a turn. */
async function present(body: string): Promise<string> {
  const envelope = ledger.say({ toScopeRef: scope, fromScopeRef: sender, body })
  await ledger.present({
    envelope: envelope.id,
    runtimeId,
    hostSessionId,
    generation: '1',
    runId,
    driveAttemptId: `drive-${envelope.id}`,
  })
  return envelope.id
}

async function stopDecision(): Promise<Record<string, unknown>> {
  const response = await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
  expect(response.status).toBe(200)
  return (await response.json()) as Record<string, unknown>
}

describe('T-07615 — the Stop gate over the wrkq ledger', () => {
  it('blocks twice with a bounded summary, then allows on the third refusal', async () => {
    await present(`drain me ${'x'.repeat(8_000)}`)

    for (let refusal = 1; refusal <= 2; refusal += 1) {
      const decision = await stopDecision()
      expect(decision).toMatchObject({
        decision: 'block',
        runId,
        targetSessionRef: target,
        unackedCount: 1,
        refusalCount: refusal,
      })
      expect(String(decision['reason'])).toContain('wrkc inbox')
      expect(String(decision['reason']).length).toBeLessThanOrEqual(4_096)
    }

    expect(await stopDecision()).toMatchObject({
      decision: 'allow',
      reason: 'refusal_cap',
      refusalCount: 3,
    })
  })

  it('does not block on an obligation the agent was never shown', async () => {
    // Pending, not presented. wrkq keeps it out of `blocking` precisely so an
    // unseen obligation cannot trap a turn.
    ledger.say({ toScopeRef: scope, fromScopeRef: sender, body: 'never presented' })
    expect(await stopDecision()).toMatchObject({
      decision: 'allow',
      reason: 'clear',
      unackedCount: 0,
    })
  })

  it('resets the cycle on new mail and clears once the obligations are answered', async () => {
    await present('first envelope')
    await stopDecision()
    await stopDecision()

    await present('new envelope')
    expect(await stopDecision()).toMatchObject({
      decision: 'block',
      refusalCount: 1,
      totalRefusalCount: 3,
      unackedCount: 2,
    })

    // A reply IS the ack, and a defer leaves the gate the same way: both simply
    // stop appearing in wrkq's blocking set.
    for (const envelope of ledger.envelopes.values()) ledger.ack(envelope.id)

    expect(await stopDecision()).toMatchObject({
      decision: 'allow',
      reason: 'clear',
      unackedCount: 0,
    })
  })

  it('FAILS OPEN when wrkq is unreachable', async () => {
    await present('this would block if the ledger answered')
    expect(await stopDecision()).toMatchObject({ decision: 'block' })

    ledger.unavailable = true
    expect(await stopDecision()).toMatchObject({
      decision: 'allow',
      reason: 'ledger_unavailable',
      runId,
      targetSessionRef: target,
    })
  })

  it('allows unknown and idle runtimes without consulting the ledger at all', async () => {
    ledger.unavailable = true
    const unknown = await fixture.postJson('/v1/internal/mail/stop-decision', {
      runtimeId: 'rt-missing',
    })
    expect(await unknown.json()).toEqual({ decision: 'allow', reason: 'no_active_turn' })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.runtimes.updateRunId(runtimeId, undefined, fixture.now())
    } finally {
      db.close()
    }
    const idle = await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
    expect(await idle.json()).toEqual({ decision: 'allow', reason: 'no_active_turn' })
  })
})
