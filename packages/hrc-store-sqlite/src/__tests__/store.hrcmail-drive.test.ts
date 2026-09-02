import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import type { HrcRuntimeIntent } from 'hrc-core'

import { openHrcDatabase } from '../index.js'
import type { HrcDatabase } from '../index.js'

/**
 * The drive slot after the wrkq re-point (T-07615).
 *
 * What this repository owns is now exactly the execution half: one slot per
 * scope, a stable `driveAttemptId` and run id across a crash, and the local
 * receipt of which envelopes an attempt presented. The obligations themselves —
 * their state, their rounds, their dead-lettering — live in wrkq, so nothing
 * here asserts about them: the actionable set arrives as an argument.
 */

const target = 'agent:cody:project:hrc-runtime:task:T-07615/lane:main'
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

function actionable(...envelopeIds: string[]) {
  return { envelopeIds, materializationIntent: intent }
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
  it('carries the ledger-supplied materialization intent onto the claim', () => {
    const claim = db.mailDrives.claim(target, 'insert', actionable('EN-00001'))
    expect(claim.outcome).toBe('acquired')
    expect('attempt' in claim ? claim.attempt.materializationIntent : undefined).toEqual(intent)
  })

  it('is clear when wrkq reports no obligations, and claims nothing', () => {
    const claim = db.mailDrives.claim(target, 'insert', { envelopeIds: [] })
    expect(claim.outcome).toBe('clear')
    expect(db.mailDrives.getSlot(target)?.activeDriveAttemptId).toBeUndefined()
    expect(db.mailDrives.listAttempts(target)).toHaveLength(0)
  })

  it('linearizes racing wakes through one durable scope slot and stable attempt', () => {
    const other = openHrcDatabase(dbPath)
    try {
      const first = db.mailDrives.claim(target, 'insert', actionable('EN-00001'), {
        driveAttemptId: 'drive-stable',
        runId: 'run-stable',
      })
      const raced = other.mailDrives.claim(target, 'periodic', actionable('EN-00001'))

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
    const claimed = db.mailDrives.claim(target, 'insert', actionable('EN-00001'), {
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
    const recovered = db.mailDrives.claim(target, 'recovery', actionable('EN-00001'))
    expect(recovered.outcome).toBe('active')
    expect('attempt' in recovered ? recovered.attempt.runId : undefined).toBe('run-before-kill')
    expect(db.mailDrives.listAttempts(target)).toHaveLength(1)
  })

  it('coalesces one durable held queue batch without taking the scope slot', () => {
    const first = db.mailDrives.holdQueuedAttempt(
      {
        targetSessionRef: target,
        wakeReason: 'insert',
        envelopeIds: ['EN-00031'],
        heldBehindTurnId: 'turn-human',
        hostSessionId: 'hsid-mail-drive',
        generation: 1,
        runtimeId: 'rt-mail-drive',
      },
      3
    )
    const appended = db.mailDrives.holdQueuedAttempt(
      {
        targetSessionRef: target,
        wakeReason: 'insert',
        envelopeIds: ['EN-00031', 'EN-00032', 'EN-00033', 'EN-00034'],
        heldBehindTurnId: 'turn-human',
        hostSessionId: 'hsid-mail-drive',
        generation: 1,
        runtimeId: 'rt-mail-drive',
      },
      3
    )

    expect(first.attempt.driveAttemptId).toBe(appended.attempt.driveAttemptId)
    expect(appended.addedEnvelopeIds).toEqual(['EN-00032', 'EN-00033'])
    expect(appended.attempt).toMatchObject({
      state: 'held',
      presentedCount: 3,
      heldBehindTurnId: 'turn-human',
      hostSessionId: 'hsid-mail-drive',
      generation: 1,
      runtimeId: 'rt-mail-drive',
    })
    expect(db.mailDrives.presentationEnvelopeIds(appended.attempt.driveAttemptId)).toEqual([
      'EN-00031',
      'EN-00032',
      'EN-00033',
    ])
    expect(db.mailDrives.getActiveAttempt(target)).toBeUndefined()
    expect(db.mailDrives.listInFlightTargets()).toEqual([target])
  })

  it('recovers a held batch after restart, then freezes it into the ordinary slot', () => {
    const held = db.mailDrives.holdQueuedAttempt(
      {
        targetSessionRef: target,
        wakeReason: 'insert',
        envelopeIds: ['EN-00041', 'EN-00042'],
        heldBehindTurnId: 'turn-before-kill',
        hostSessionId: 'hsid-mail-drive',
        generation: 1,
        runtimeId: 'rt-mail-drive',
      },
      20
    ).attempt
    db.close()

    db = openHrcDatabase(dbPath)
    expect(db.mailDrives.getHeldAttempt(target)).toMatchObject({
      driveAttemptId: held.driveAttemptId,
      runId: held.runId,
      state: 'held',
    })
    const activated = db.mailDrives.activateHeldAttempt(held.driveAttemptId)
    expect(activated.outcome).toBe('acquired')
    expect('attempt' in activated ? activated.attempt : undefined).toMatchObject({
      driveAttemptId: held.driveAttemptId,
      runId: held.runId,
      state: 'claimed',
    })
    expect(db.mailDrives.getActiveAttempt(target)?.driveAttemptId).toBe(held.driveAttemptId)
    expect(db.mailDrives.getHeldAttempt(target)).toBeUndefined()
  })

  it('atomically activates selected held members and leaves the rest held', () => {
    const held = db.mailDrives.holdQueuedAttempt(
      {
        targetSessionRef: target,
        wakeReason: 'turn_completion',
        envelopeIds: ['EN-00043', 'EN-00044', 'EN-00045'],
        heldBehindTurnId: 'turn-before-split',
        hostSessionId: 'hsid-mail-drive',
        generation: 1,
        runtimeId: 'rt-mail-drive',
      },
      20
    ).attempt

    const activated = db.mailDrives.activateHeldAttempt(held.driveAttemptId, [
      'EN-00043',
      'EN-00045',
    ])
    expect(activated.outcome).toBe('acquired')
    expect(db.mailDrives.presentationEnvelopeIds(held.driveAttemptId)).toEqual([
      'EN-00043',
      'EN-00045',
    ])
    expect(db.mailDrives.getActiveAttempt(target)).toMatchObject({
      driveAttemptId: held.driveAttemptId,
      state: 'claimed',
      presentedCount: 2,
    })

    const successor = db.mailDrives.getHeldAttempt(target)
    expect(successor).toMatchObject({
      state: 'held',
      presentedCount: 1,
      heldBehindTurnId: 'turn-before-split',
    })
    expect(db.mailDrives.presentationEnvelopeIds(successor?.driveAttemptId ?? '')).toEqual([
      'EN-00044',
    ])
  })

  it('subtracts terminal members locally and terminalizes an emptied held batch', () => {
    const held = db.mailDrives.holdQueuedAttempt(
      {
        targetSessionRef: target,
        wakeReason: 'insert',
        envelopeIds: ['EN-00051', 'EN-00052'],
        heldBehindTurnId: 'turn-live',
        hostSessionId: 'hsid-mail-drive',
        generation: 1,
        runtimeId: 'rt-mail-drive',
      },
      20
    ).attempt

    expect(db.mailDrives.dropHeldEnvelope('EN-00051', 'acked_while_held')).toMatchObject({
      remainingEnvelopeIds: ['EN-00052'],
      attempt: { driveAttemptId: held.driveAttemptId, state: 'held', presentedCount: 1 },
    })
    expect(db.mailDrives.dropHeldEnvelope('EN-00052', 'expired_while_held')).toMatchObject({
      remainingEnvelopeIds: [],
      attempt: { driveAttemptId: held.driveAttemptId, state: 'withdrawn', presentedCount: 0 },
    })
    expect(db.mailDrives.getHeldAttempt(target)).toBeUndefined()
    expect(db.mailDrives.listInFlightTargets()).toEqual([])
  })

  it('records one presentation receipt per envelope no matter how often the attempt replays', () => {
    db.mailDrives.claim(target, 'insert', actionable('EN-00001', 'EN-00002'), {
      driveAttemptId: 'drive-replay',
      runId: 'run-replay',
    })
    const first = db.mailDrives.presentForAttempt('drive-replay', ['EN-00001', 'EN-00002'])
    expect(first).toEqual(['EN-00001', 'EN-00002'])

    // The kill-between-persist-and-dispatch replay: same attempt, same ids.
    const replayed = db.mailDrives.presentForAttempt('drive-replay', ['EN-00001', 'EN-00002'])
    expect(replayed).toEqual(['EN-00001', 'EN-00002'])
    expect(db.mailDrives.presentationEnvelopeIds('drive-replay')).toEqual(['EN-00001', 'EN-00002'])
  })

  it('reports the presented envelopes on completion and releases the slot', () => {
    db.mailDrives.claim(target, 'insert', actionable('EN-00007'), {
      driveAttemptId: 'drive-complete',
      runId: 'run-complete',
    })
    db.mailDrives.presentForAttempt('drive-complete', ['EN-00007'])
    db.mailDrives.recordPresentation('drive-complete', '[T-07615 · mable@wrkq:primary → you]', 1)
    startAttempt('run-complete', 101)

    const completed = db.mailDrives.completeStartedAttempt('run-complete', 'turn.completed')
    // Rounds are wrkq's; HRC reports WHICH envelopes the finished turn presented
    // and lets the owner decide whether any of them burns a round.
    expect(completed?.presentedEnvelopeIds).toEqual(['EN-00007'])
    expect(completed?.attempt.state).toBe('completed')
    expect(completed?.attempt.prompt).toBe('[T-07615 · mable@wrkq:primary → you]')
    expect(db.mailDrives.getSlot(target)?.activeDriveAttemptId).toBeUndefined()
  })

  it('persists the bodyless auto-reply intent inside successful drive completion', () => {
    db.mailDrives.claim(target, 'insert', actionable('EN-00021'), {
      driveAttemptId: 'drive-auto-reply',
      runId: 'run-auto-reply',
    })
    db.mailDrives.presentForAttempt('drive-auto-reply', ['EN-00021'])
    db.mailDrives.recordAutoReplyCandidate('drive-auto-reply', {
      sourceRef: 'EN-00021',
      sourceEnvelopeIds: ['EN-00021'],
      roomKey: 'T-07820',
      counterpartyRef: 'chief@hcs:T-07789',
    })
    startAttempt('run-auto-reply', 121)

    db.mailDrives.completeStartedAttempt('run-auto-reply', 'turn.completed')
    expect(db.mailDrives.getAutoReplyIntent('drive-auto-reply')).toMatchObject({
      driveAttemptId: 'drive-auto-reply',
      sourceRef: 'EN-00021',
      sourceEnvelopeIds: ['EN-00021'],
      roomKey: 'T-07820',
      counterpartyRef: 'chief@hcs:T-07789',
      runId: 'run-auto-reply',
      targetSessionRef: target,
      state: 'pending',
      attemptCount: 0,
    })

    // The row, not an in-memory finalizer, is restart authority.
    db.close()
    db = openHrcDatabase(dbPath)
    expect(db.mailDrives.listPendingAutoReplyIntents()).toHaveLength(1)
    db.mailDrives.recordAutoReplyDischargeOutcome('drive-auto-reply', {
      source: 'manifest',
      envelopeIds: ['EN-00021'],
      refusedEnvelopeId: 'EN-00022',
      refusalCode: 'WRKQ_VALIDATION',
    })
    expect(db.mailDrives.getAutoReplyIntent('drive-auto-reply')?.dischargeOutcome).toEqual({
      source: 'manifest',
      envelopeIds: ['EN-00021'],
      refusedEnvelopeId: 'EN-00022',
      refusalCode: 'WRKQ_VALIDATION',
    })
  })

  it('never creates auto-reply intent for an unsuccessful drive completion', () => {
    db.mailDrives.claim(target, 'insert', actionable('EN-00022'), {
      driveAttemptId: 'drive-auto-reply-failed',
      runId: 'run-auto-reply-failed',
    })
    db.mailDrives.presentForAttempt('drive-auto-reply-failed', ['EN-00022'])
    db.mailDrives.recordAutoReplyCandidate('drive-auto-reply-failed', {
      sourceRef: 'EN-00022',
      sourceEnvelopeIds: ['EN-00022'],
      roomKey: 'T-07820',
      counterpartyRef: 'chief@hcs:T-07789',
    })
    startAttempt('run-auto-reply-failed', 122)

    db.mailDrives.completeStartedAttempt('run-auto-reply-failed', 'turn.failed')
    expect(db.mailDrives.getAutoReplyIntent('drive-auto-reply-failed')).toBeUndefined()
  })

  it('releases a no-op attempt without reporting anything to advance', () => {
    db.mailDrives.claim(target, 'insert', actionable('EN-00009'), {
      driveAttemptId: 'drive-clear',
      runId: 'run-clear',
    })
    const noOp = db.mailDrives.completeNoOp('drive-clear')
    expect(noOp.state).toBe('no_op')
    expect(db.mailDrives.getSlot(target)?.activeDriveAttemptId).toBeUndefined()
  })

  it('reports only attempts still in flight as sweep targets', () => {
    expect(db.mailDrives.listInFlightTargets()).toEqual([])

    db.mailDrives.claim(target, 'insert', actionable('EN-00001'), {
      driveAttemptId: 'drive-inflight',
      runId: 'run-inflight',
    })
    // An in-flight attempt survives a restart and must still be observed: it
    // owns a scope slot nothing else can claim until it finishes.
    db.close()
    db = openHrcDatabase(dbPath)
    expect(db.mailDrives.listInFlightTargets()).toEqual([target])

    db.mailDrives.completeNoOp('drive-inflight')
    expect(db.mailDrives.listInFlightTargets()).toEqual([])
  })
})
