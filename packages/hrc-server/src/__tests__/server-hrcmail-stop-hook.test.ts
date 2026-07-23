import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcMailSendRequest } from 'hrc-core'
import { openHrcDatabase } from 'hrc-store-sqlite'

import { createHrcServer } from '../index.js'
import type { HrcServer } from '../index.js'
import { type HrcServerTestFixture, createHrcTestFixture } from './fixtures/hrc-test-fixture.js'

const scope = 'agent:cody:project:hrc-runtime:task:T-06810-stop'
const target = `${scope}/lane:main`
const sender = 'agent:mable:project:hrc-runtime:task:T-06810/lane:main'
const runtimeId = 'rt-mail-stop-hook'
const runId = 'run-mail-stop-hook'
const hostSessionId = 'hsid-mail-stop-hook'

let fixture: HrcServerTestFixture
let server: HrcServer

beforeEach(async () => {
  fixture = await createHrcTestFixture('hrc-mail-stop-hook-')
  server = await createHrcServer(fixture.serverOpts({ otelListenerEnabled: false }))
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

function request(ingressId: string, body: string): HrcMailSendRequest {
  return {
    ingressId,
    from: { kind: 'scope', sessionRef: sender },
    targetSessionRef: target,
    payload: { kind: 'request', body },
  }
}

describe('T-06810 Wave 3 — hrcmail Stop predicate', () => {
  it('blocks twice with a bounded inbox summary, then allows on the third refusal', async () => {
    const sent = await fixture.postJson(
      '/v1/mail/send',
      request('stop-hook-cap', `drain me ${'x'.repeat(8_000)}`)
    )
    expect(sent.status).toBe(200)

    for (let refusal = 1; refusal <= 2; refusal += 1) {
      const response = await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
      expect(response.status).toBe(200)
      const decision = (await response.json()) as Record<string, unknown>
      expect(decision).toMatchObject({
        decision: 'block',
        runId,
        targetSessionRef: target,
        unackedCount: 1,
        refusalCount: refusal,
      })
      expect(String(decision['reason'])).toContain('hrcmail inbox')
      expect(String(decision['reason']).length).toBeLessThanOrEqual(4_096)
    }

    const released = await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
    expect(await released.json()).toMatchObject({
      decision: 'allow',
      reason: 'refusal_cap',
      refusalCount: 3,
    })
  })

  it('new ingress resets the cycle and deferred rows leave the predicate', async () => {
    const first = await fixture.postJson(
      '/v1/mail/send',
      request('stop-hook-reset-1', 'first envelope')
    )
    const firstBody = (await first.json()) as { envelope: { envelopeId: string } }
    await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
    await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })

    await fixture.postJson('/v1/mail/send', request('stop-hook-reset-2', 'new envelope'))
    const reset = await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
    expect(await reset.json()).toMatchObject({
      decision: 'block',
      refusalCount: 1,
      totalRefusalCount: 3,
      unackedCount: 2,
    })

    const db = openHrcDatabase(fixture.dbPath)
    try {
      db.mailEnvelopes.presentPendingForTarget(target)
    } finally {
      db.close()
    }
    const deferred = await fixture.postJson('/v1/mail/defer', {
      actor: { kind: 'scope', sessionRef: target },
      envelopeId: firstBody.envelope.envelopeId,
      reason: 'later',
    })
    expect(deferred.status).toBe(200)

    const secondInbox = await fixture.postJson('/v1/mail/inbox', {
      actor: { kind: 'scope', sessionRef: target },
      targetSessionRef: target,
    })
    const secondEnvelopeId = (
      (await secondInbox.json()) as {
        envelopes: Array<{ envelopeId: string }>
      }
    ).envelopes[0]?.envelopeId
    expect(secondEnvelopeId).toBeDefined()
    const deferredSecond = await fixture.postJson('/v1/mail/defer', {
      actor: { kind: 'scope', sessionRef: target },
      envelopeId: secondEnvelopeId,
      reason: 'also later',
    })
    expect(deferredSecond.status).toBe(200)

    const clear = await fixture.postJson('/v1/internal/mail/stop-decision', { runtimeId })
    expect(await clear.json()).toMatchObject({
      decision: 'allow',
      reason: 'clear',
      unackedCount: 0,
    })
  })

  it('allows unknown and idle runtimes without creating refusal state', async () => {
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
