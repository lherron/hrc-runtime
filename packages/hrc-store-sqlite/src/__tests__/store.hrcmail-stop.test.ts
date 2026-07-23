import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMailActor } from 'hrc-core'

import { HRC_MAIL_STOP_HARD_CAP, HRC_MAIL_STOP_REFUSAL_CAP, openHrcDatabase } from '../index.js'
import type { HrcDatabase } from '../index.js'

const scope = 'agent:cody:project:hrc-runtime:task:T-06810'
const target = `${scope}/lane:main`
const sender: HrcMailActor = {
  kind: 'scope',
  sessionRef: 'agent:mable:project:hrc-runtime:task:T-06810/lane:main',
}

let tmpDir: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-mail-stop-test-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
  seedTurn('run-mail-stop-1')
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function seedTurn(runId: string): void {
  const now = new Date().toISOString()
  if (db.sessions.getByHostSessionId('hsid-mail-stop') === null) {
    db.sessions.insert({
      hostSessionId: 'hsid-mail-stop',
      scopeRef: scope,
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    db.runtimes.insert({
      runtimeId: 'rt-mail-stop',
      hostSessionId: 'hsid-mail-stop',
      scopeRef: scope,
      laneRef: 'main',
      generation: 1,
      transport: 'tmux',
      harness: 'claude-code',
      provider: 'anthropic',
      status: 'busy',
      supportsInflightInput: false,
      adopted: false,
      activeRunId: runId,
      createdAt: now,
      updatedAt: now,
    })
  }
  db.runs.insert({
    runId,
    hostSessionId: 'hsid-mail-stop',
    runtimeId: 'rt-mail-stop',
    scopeRef: scope,
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: 'running',
    acceptedAt: now,
    startedAt: now,
    updatedAt: now,
  })
  db.runtimes.updateRunId('rt-mail-stop', runId, now)
}

function send(ingressId: string): string {
  return db.mailEnvelopes.create({
    ingressId,
    from: sender,
    targetSessionRef: target,
    payload: { kind: 'request', body: `mail ${ingressId}` },
  }).envelope.envelopeId
}

describe('HrcMailStopRefusalRepository', () => {
  it('blocks pending/presented rows, excludes deferred rows, and allows a clear inbox', () => {
    const envelopeId = send('stop-predicate')
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target)).toMatchObject({
      decision: 'block',
      unackedCount: 1,
      refusalCount: 1,
    })

    db.mailEnvelopes.presentPendingForTarget(target)
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target)).toMatchObject({
      decision: 'block',
      unackedCount: 1,
      refusalCount: 2,
    })
    db.mailEnvelopes.defer({
      actor: { kind: 'scope', sessionRef: target },
      envelopeId,
      reason: 'later',
    })
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target)).toMatchObject({
      decision: 'allow',
      reason: 'clear',
      unackedCount: 0,
    })
  })

  it('allows the third refusal, resets the cycle only for new ingress, and caps at 50', () => {
    send('stop-cap-1')
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target).decision).toBe('block')
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target).decision).toBe('block')
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target)).toMatchObject({
      decision: 'allow',
      reason: 'refusal_cap',
      refusalCount: HRC_MAIL_STOP_REFUSAL_CAP,
      totalRefusalCount: 3,
    })

    send('stop-cap-2')
    expect(db.mailStopRefusals.get('run-mail-stop-1')).toMatchObject({
      refusalCount: 0,
      totalRefusalCount: 3,
    })
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target)).toMatchObject({
      decision: 'block',
      refusalCount: 1,
      totalRefusalCount: 4,
    })

    db.sqlite
      .query(
        `UPDATE hrcmail_stop_refusals
         SET refusal_count = 0, total_refusal_count = ?
         WHERE run_id = ?`
      )
      .run(HRC_MAIL_STOP_HARD_CAP - 1, 'run-mail-stop-1')
    send('stop-cap-hard')
    expect(db.mailStopRefusals.evaluate('run-mail-stop-1', target)).toMatchObject({
      decision: 'allow',
      reason: 'hard_cap',
      totalRefusalCount: HRC_MAIL_STOP_HARD_CAP,
    })

    const retried = db.mailEnvelopes.create({
      ingressId: 'stop-cap-hard',
      from: sender,
      targetSessionRef: target,
      payload: { kind: 'request', body: 'mail stop-cap-hard' },
    })
    expect(retried.envelope.ingressId).toBe('stop-cap-hard')
    expect(db.mailStopRefusals.get('run-mail-stop-1')?.totalRefusalCount).toBe(
      HRC_MAIL_STOP_HARD_CAP
    )
  })

  it('starts fresh counters for a new stable run id', () => {
    send('stop-new-turn')
    db.mailStopRefusals.evaluate('run-mail-stop-1', target)
    db.mailStopRefusals.evaluate('run-mail-stop-1', target)
    seedTurn('run-mail-stop-2')

    expect(db.mailStopRefusals.evaluate('run-mail-stop-2', target)).toMatchObject({
      decision: 'block',
      refusalCount: 1,
      totalRefusalCount: 1,
    })
  })
})
