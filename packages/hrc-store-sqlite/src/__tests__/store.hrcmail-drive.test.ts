import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcMailActor, HrcRuntimeIntent } from 'hrc-core'

import { openHrcDatabase } from '../index.js'
import type { HrcDatabase } from '../index.js'

const target = 'agent:cody:project:hrc-runtime:task:T-06810/lane:main'
const actor: HrcMailActor = { kind: 'scope', sessionRef: target }
const sender: HrcMailActor = {
  kind: 'scope',
  sessionRef: 'agent:mable:project:hrc-runtime:task:T-06810/lane:main',
}
const intent: HrcRuntimeIntent = {
  placement: {
    agentRoot: '/tmp/cody',
    projectRoot: '/tmp/hrc-runtime',
    cwd: '/tmp/hrc-runtime',
    runMode: 'task',
    bundle: { kind: 'compose', compose: [] },
    dryRun: true,
  },
  harness: {
    provider: 'openai',
    id: 'codex-cli',
    interactive: false,
  },
  execution: { preferredMode: 'nonInteractive' },
}

let tmpDir: string
let dbPath: string
let db: HrcDatabase

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-mail-drive-test-'))
  dbPath = join(tmpDir, 'state.sqlite')
  db = openHrcDatabase(dbPath)
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function send(ingressId: string, kind: 'request' | 'conversational' = 'request') {
  return db.mailEnvelopes.create({
    ingressId,
    from: sender,
    targetSessionRef: target,
    payload: { kind, body: `${kind} ${ingressId}` },
    materializationIntent: intent,
  }).envelope
}

function startAttempt(runId: string, hrcSeq: number) {
  return db.mailDrives.recordStart({
    runId,
    startHrcSeq: hrcSeq,
    startedAt: new Date().toISOString(),
    hostSessionId: 'hsid-mail-drive',
    generation: 1,
    runtimeId: 'rt-mail-drive',
  })
}

describe('HrcMailDriveRepository', () => {
  it('backfills a missing materialization hint on an idempotent pre-Wave-2 retry', () => {
    const base = {
      ingressId: 'drive-intent-backfill',
      from: sender,
      targetSessionRef: target,
      payload: { kind: 'request' as const, body: 'same semantic envelope' },
    }
    const original = db.mailEnvelopes.create(base)
    const retried = db.mailEnvelopes.create({ ...base, materializationIntent: intent })
    expect(retried.receipt).toEqual(original.receipt)

    const claim = db.mailDrives.claim(target, 'insert')
    expect(claim.outcome).toBe('acquired')
    expect('attempt' in claim ? claim.attempt.materializationIntent : undefined).toEqual(intent)
  })

  it('linearizes racing wakes through one durable scope slot and stable attempt', () => {
    send('drive-race')
    const other = openHrcDatabase(dbPath)
    try {
      const first = db.mailDrives.claim(target, 'insert', {
        driveAttemptId: 'drive-stable',
        runId: 'run-stable',
      })
      const raced = other.mailDrives.claim(target, 'periodic')

      expect(first.outcome).toBe('acquired')
      expect(raced.outcome).toBe('active')
      expect('attempt' in raced ? raced.attempt.driveAttemptId : undefined).toBe('drive-stable')
      expect(db.mailDrives.getSlot(target)).toMatchObject({
        targetSessionRef: target,
        activeDriveAttemptId: 'drive-stable',
      })
      expect(db.mailDrives.listAttempts(target)).toHaveLength(1)
      expect(db.mailDrives.getAttempt('drive-stable')?.runId).toBe('run-stable')
    } finally {
      other.close()
    }
  })

  it('survives restart after slot persistence and recovers the same run identity', () => {
    send('drive-restart')
    const claimed = db.mailDrives.claim(target, 'insert', {
      driveAttemptId: 'drive-before-kill',
      runId: 'run-before-kill',
    })
    expect(claimed.outcome).toBe('acquired')
    db.close()

    db = openHrcDatabase(dbPath)
    expect(db.mailDrives.getActiveAttempt(target)).toMatchObject({
      driveAttemptId: 'drive-before-kill',
      runId: 'run-before-kill',
      state: 'claimed',
    })
    const recovered = db.mailDrives.claim(target, 'recovery')
    expect(recovered.outcome).toBe('active')
    expect('attempt' in recovered ? recovered.attempt.runId : undefined).toBe('run-before-kill')
    expect(db.mailDrives.listAttempts(target)).toHaveLength(1)
  })

  it('counts only unresolved presentations and dead-letters on the fifth completed round', () => {
    const acknowledged = send('drive-acked')
    const stuck = send('drive-stuck')
    send('drive-conversation', 'conversational')

    const first = db.mailDrives.claim(target, 'insert', {
      driveAttemptId: 'drive-round-1',
      runId: 'run-round-1',
    })
    expect(first.outcome).toBe('acquired')
    const firstPresented = db.mailDrives.presentForAttempt('drive-round-1', (id) =>
      db.mailEnvelopes.require(id)
    )
    expect(firstPresented.map((envelope) => envelope.envelopeId)).toEqual([
      acknowledged.envelopeId,
      stuck.envelopeId,
    ])
    expect(db.mailEnvelopes.list({ state: 'acked' })).toHaveLength(1)

    db.mailEnvelopes.ack({ actor, envelopeIds: [acknowledged.envelopeId] })
    startAttempt('run-round-1', 101)
    const completed = db.mailDrives.completeStartedAttempt('run-round-1', 'turn.completed', 5)
    expect(completed).toMatchObject({ roundsAdvanced: 1, deadLettered: 0 })
    expect(db.mailEnvelopes.require(acknowledged.envelopeId).roundCount).toBe(0)
    expect(db.mailEnvelopes.require(stuck.envelopeId)).toMatchObject({
      state: 'presented',
      roundCount: 1,
    })

    for (let round = 2; round <= 5; round += 1) {
      const driveAttemptId = `drive-round-${round}`
      const runId = `run-round-${round}`
      const claim = db.mailDrives.claim(target, 'turn_completion', {
        driveAttemptId,
        runId,
      })
      expect(claim.outcome).toBe('acquired')
      db.mailDrives.presentForAttempt(driveAttemptId, (id) => db.mailEnvelopes.require(id))
      startAttempt(runId, 100 + round)
      db.mailDrives.completeStartedAttempt(runId, 'turn.completed', 5)
    }

    expect(db.mailEnvelopes.require(stuck.envelopeId)).toMatchObject({
      state: 'dead',
      roundCount: 5,
    })
    expect(db.mailDrives.getSlot(target)?.activeDriveAttemptId).toBeUndefined()
  })

  it('releases a clear/no-start attempt without consuming a round', () => {
    const envelope = send('drive-clear')
    const claim = db.mailDrives.claim(target, 'insert', {
      driveAttemptId: 'drive-clear',
      runId: 'run-clear',
    })
    expect(claim.outcome).toBe('acquired')
    db.mailDrives.presentForAttempt('drive-clear', (id) => db.mailEnvelopes.require(id))
    db.mailEnvelopes.ack({ actor, envelopeIds: [envelope.envelopeId] })

    const noOp = db.mailDrives.completeNoOp('drive-clear')
    expect(noOp.state).toBe('no_op')
    expect(db.mailEnvelopes.require(envelope.envelopeId)).toMatchObject({
      state: 'acked',
      roundCount: 0,
    })
    expect(db.mailDrives.getSlot(target)?.activeDriveAttemptId).toBeUndefined()
  })
})
