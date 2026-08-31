import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailAutoReplyIntent } from 'hrc-store-sqlite'

import { autoReplyCandidateFor, reconcileAutoReplyIntent } from '../auto-reply-handlers.js'
import { TURN_TEXT_LIMIT, appendHrcEvent } from '../hrc-event-helper.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'

const TARGET = 'agent:cody:project:hrc-runtime:task:T-07820/lane:main'
const LEDGER_TARGET = 'cody@hrc-runtime:T-07820'
const COUNTERPARTY = 'chief@hcs:T-07789'
const ROOM = 'T-07820'

let tmpDir: string
let dbPath: string
let db: HrcDatabase
let ledger: FakeWrkqLedger
let sequence = 0

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 'hrc-auto-reply-test-'))
  dbPath = join(tmpDir, 'state.sqlite')
  db = openHrcDatabase(dbPath)
  ledger = new FakeWrkqLedger()
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

async function pendingIntent(
  body: string | string[] | undefined = 'Canonical final answer'
): Promise<{
  intent: HrcMailAutoReplyIntent
  sourceId: string
}> {
  sequence += 1
  const source = ledger.say({
    toScopeRef: LEDGER_TARGET,
    fromScopeRef: COUNTERPARTY,
    fromPrincipalRef: 'agent:chief',
    roomKey: ROOM,
    body: `request ${sequence}`,
  })
  const candidate = autoReplyCandidateFor([source])
  if (candidate === undefined) throw new Error('expected one source to be auto-reply eligible')
  const driveAttemptId = `drive-auto-${sequence}`
  const runId = `run-auto-${sequence}`
  db.mailDrives.claim(TARGET, 'insert', { envelopeIds: [source.id] }, { driveAttemptId, runId })
  db.mailDrives.presentForAttempt(driveAttemptId, [source.id])
  db.mailDrives.recordAutoReplyCandidate(driveAttemptId, candidate)
  await ledger.present({
    envelope: source.id,
    driveAttemptId,
    runtimeId: `rt-auto-${sequence}`,
    runId,
  })
  if (body !== undefined) {
    const now = new Date().toISOString()
    db.sessions.insert({
      hostSessionId: `hsid-auto-${sequence}`,
      scopeRef: 'agent:cody:project:hrc-runtime:task:T-07820',
      laneRef: 'main',
      generation: 1,
      status: 'active',
      createdAt: now,
      updatedAt: now,
      ancestorScopeRefs: [],
    })
    for (const content of Array.isArray(body) ? body : [body]) {
      appendHrcEvent(db, 'turn.message', {
        ts: now,
        hostSessionId: `hsid-auto-${sequence}`,
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-07820',
        laneRef: 'main',
        generation: 1,
        runId,
        runtimeId: `rt-auto-${sequence}`,
        payload: { message: { role: 'assistant', content } },
      })
    }
  }
  db.mailDrives.recordStart({
    runId,
    startHrcSeq: sequence,
    startedAt: new Date().toISOString(),
    hostSessionId: `hsid-auto-${sequence}`,
    generation: 1,
    runtimeId: `rt-auto-${sequence}`,
  })
  db.mailDrives.completeStartedAttempt(runId, 'turn.completed')
  const intent = db.mailDrives.getAutoReplyIntent(driveAttemptId)
  if (intent === undefined) throw new Error('completion did not persist auto-reply intent')
  return { intent, sourceId: source.id }
}

describe('T-07820 auto-reply eligibility', () => {
  it('admits one pending envelope or one fan-out group from one sender only', () => {
    const first = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      roomKey: ROOM,
    })
    expect(autoReplyCandidateFor([first])).toMatchObject({
      sourceRef: first.id,
      sourceEnvelopeIds: [first.id],
      roomKey: ROOM,
      counterpartyRef: COUNTERPARTY,
    })

    const sibling = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      roomKey: ROOM,
    })
    first.groupId = 'EN-fanout'
    sibling.groupId = 'EN-fanout'
    expect(autoReplyCandidateFor([first, sibling])).toMatchObject({
      sourceRef: 'EN-fanout',
      sourceEnvelopeIds: [first.id, sibling.id],
    })

    sibling.groupId = sibling.id
    expect(autoReplyCandidateFor([first, sibling])).toBeUndefined()
    sibling.groupId = 'EN-fanout'
    sibling.state = 'presented'
    expect(autoReplyCandidateFor([first, sibling])).toBeUndefined()
  })
})

describe('T-07820 auto-reply reconciliation', () => {
  it('mints through plain say with exact identity, idempotency, and provenance', async () => {
    const { intent } = await pendingIntent()

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)).toMatchObject({
      state: 'minted',
      attemptCount: 1,
      sayAttemptCount: 1,
      verificationPending: false,
    })
    expect(ledger.roomSayRequests).toEqual([
      {
        ref: ROOM,
        body: 'Canonical final answer',
        to: [COUNTERPARTY],
        idempotencyKey: `auto-reply:${intent.driveAttemptId}`,
        meta: { auto: 'turn_final' },
        principalRef: 'agent:cody',
        scopeRef: LEDGER_TARGET,
      },
    ])
  })

  it('separates multiple semantic turn messages in the canonical response body', async () => {
    const { intent } = await pendingIntent([
      "I'll check with pwd and return the exact path.",
      '/Users/lherron/praesidium/signal-pipeline',
    ])

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests[0]?.body).toBe(
      "I'll check with pwd and return the exact path.\n\n/Users/lherron/praesidium/signal-pipeline"
    )
  })

  it('records already-discharged when a manual reply won precedence', async () => {
    const { intent, sourceId } = await pendingIntent()
    ledger.ack(sourceId)

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe(
      'already-discharged'
    )
    expect(ledger.roomSayRequests).toHaveLength(0)
  })

  it('records empty-response without fabricating content', async () => {
    const { intent } = await pendingIntent('')

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe(
      'empty-response'
    )
    expect(ledger.roomSayRequests).toHaveLength(0)
  })

  it('inherits and marks TURN_TEXT_LIMIT truncation in the minted body', async () => {
    const { intent } = await pendingIntent('x'.repeat(TURN_TEXT_LIMIT + 99))

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests[0]?.body).toHaveLength(TURN_TEXT_LIMIT)
  })

  it('rebuilds a pending prior-say verification after restart and correlates by read', async () => {
    const { intent } = await pendingIntent()
    const key = `auto-reply:${intent.driveAttemptId}`
    db.mailDrives.markAutoReplySayStarted(intent.driveAttemptId)
    await ledger.roomSay({
      ref: ROOM,
      body: 'Canonical final answer',
      to: [COUNTERPARTY],
      idempotencyKey: key,
      meta: { auto: 'turn_final' },
      principalRef: 'agent:cody',
      scopeRef: LEDGER_TARGET,
    })
    db.close()
    db = openHrcDatabase(dbPath)

    const recovered = db.mailDrives.listPendingAutoReplyIntents()[0]
    if (recovered === undefined) throw new Error('pending intent did not survive restart')
    expect(recovered.verificationPending).toBe(true)
    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, recovered)).toBe('minted')
    expect(ledger.roomSayRequests).toHaveLength(1)
    expect(db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)?.state).toBe('minted')
  })

  it('keeps pending and performs no retry when the F2-R verification read fails', async () => {
    const { intent } = await pendingIntent()
    let sayCalls = 0
    ledger.roomSay = async () => {
      sayCalls += 1
      throw new Error('say response lost')
    }
    ledger.roomLog = async () => {
      throw new Error('room read unavailable')
    }

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('pending')
    expect(sayCalls).toBe(1)
    expect(db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)).toMatchObject({
      state: 'pending',
      sayAttemptCount: 1,
      verificationPending: true,
    })
  })

  it('retries only after a successful read proves the ambiguous say absent', async () => {
    const { intent } = await pendingIntent()
    const realSay = ledger.roomSay.bind(ledger)
    let sayCalls = 0
    ledger.roomSay = async () => {
      sayCalls += 1
      throw new Error('definite response unavailable, outcome ambiguous')
    }

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('pending')
    expect(sayCalls).toBe(1)
    expect(db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)?.verificationPending).toBe(false)

    ledger.roomSay = async (params) => {
      sayCalls += 1
      return await realSay(params)
    }
    const retry = db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)
    if (retry === undefined) throw new Error('pending intent disappeared before retry')
    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, retry)).toBe('minted')
    expect(sayCalls).toBe(2)
  })

  it('requires both the agent principal and exact key for read correlation', async () => {
    const { intent } = await pendingIntent()
    const key = `auto-reply:${intent.driveAttemptId}`
    db.mailDrives.markAutoReplySayStarted(intent.driveAttemptId)
    await ledger.roomSay({
      ref: ROOM,
      body: 'wrong principal',
      to: [COUNTERPARTY],
      idempotencyKey: key,
      principalRef: 'agent:other',
      scopeRef: 'other@hrc-runtime:T-07820',
    })
    await ledger.roomSay({
      ref: ROOM,
      body: 'wrong key',
      to: [COUNTERPARTY],
      idempotencyKey: `${key}:other`,
      principalRef: 'agent:cody',
      scopeRef: TARGET,
    })
    ledger.roomSay = async () => {
      throw new Error('say remains ambiguous')
    }

    const pending = db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)
    if (pending === undefined) throw new Error('pending intent disappeared')
    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, pending)).toBe('pending')
    expect(db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)?.state).toBe('pending')
  })
})
