import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailAutoReplyIntent } from 'hrc-store-sqlite'

import { autoReplyCandidateFor } from 'hrc-mail-kicker'
import { reconcileAutoReplyIntent } from '../auto-reply-handlers.js'
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

type TurnSegment = string | { content: string; final?: boolean }

async function pendingIntent(
  body: string | TurnSegment[] | undefined = 'Canonical final answer'
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
    // A plain string is one message; an array is one message per entry. An
    // entry may also carry the broker's finality flag (T-07969) as
    // `{ content, final }`, which is how a narrate-then-answer turn is shaped.
    const segments = Array.isArray(body) ? body : [body]
    for (const segment of segments) {
      const content = typeof segment === 'string' ? segment : segment.content
      const final = typeof segment === 'string' ? undefined : segment.final
      appendHrcEvent(db, 'turn.message', {
        ts: now,
        hostSessionId: `hsid-auto-${sequence}`,
        scopeRef: 'agent:cody:project:hrc-runtime:task:T-07820',
        laneRef: 'main',
        generation: 1,
        runId,
        runtimeId: `rt-auto-${sequence}`,
        payload: {
          message: { role: 'assistant', content },
          ...(final === undefined ? {} : { final }),
        },
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

function seedBrokerRun(
  intent: HrcMailAutoReplyIntent,
  invocationId: string,
  submissionId: string
): void {
  const suffix = intent.runId.replace('run-auto-', '')
  const now = new Date().toISOString()
  db.runs.insert({
    runId: intent.runId,
    hostSessionId: `hsid-auto-${suffix}`,
    scopeRef: 'agent:cody:project:hrc-runtime:task:T-07820',
    laneRef: 'main',
    generation: 1,
    transport: 'headless',
    status: 'completed',
    acceptedAt: now,
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    invocationId,
    brokerSubmissionId: submissionId,
  })
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
        dischargeEnvelopeIds: [expect.stringMatching(/^EN-/)],
        meta: {
          auto: 'turn_final',
          discharge: 'candidate',
          dischargeEnvelopeIds: [expect.stringMatching(/^EN-/)],
        },
        principalRef: 'agent:cody',
        scopeRef: LEDGER_TARGET,
      },
    ])
  })

  it('discharges only the manifest-carried envelope in a multi-request turn', async () => {
    const { intent, sourceId } = await pendingIntent()
    const sibling = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:chief',
      roomKey: ROOM,
      body: 'owed outside this manifest',
    })
    await ledger.present({
      envelope: sibling.id,
      driveAttemptId: 'drive-sibling',
      runtimeId: 'rt-auto-manifest',
      runId: 'run-sibling',
    })
    seedBrokerRun(intent, 'inv-auto-manifest', 'sub-source')
    const append = (seq: number, type: string, payload: Record<string, unknown>) => {
      const time = new Date(Date.UTC(2026, 8, 2, 5, 0, seq)).toISOString()
      db.brokerInvocationEvents.appendEvent({
        invocationId: 'inv-auto-manifest',
        seq,
        time,
        type,
        runtimeId: 'rt-auto-manifest',
        runId: intent.runId,
        payload,
      })
    }
    append(1, 'admission.requested', {
      submissionId: 'sub-source',
      class: 'queue',
      origin: { principalRef: 'agent:chief', envelopeId: sourceId },
      turnPolicy: 'open',
    })
    append(2, 'submission.executed', {
      submissionId: 'sub-source',
      turnId: 'turn-manifest',
    })

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests[0]).toMatchObject({
      dischargeEnvelopeIds: [sourceId],
      meta: { discharge: 'manifest', dischargeEnvelopeIds: [sourceId] },
    })
    expect(ledger.envelopes.get(sourceId)?.state).toBe('acked')
    expect(ledger.envelopes.get(sibling.id)?.state).toBe('presented')
  })

  it('drops a typed discharge offender, retries the reduced exact set once, and never goes wide', async () => {
    const { intent, sourceId } = await pendingIntent()
    const sibling = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:chief',
      roomKey: ROOM,
      body: 'raced manual disposition',
    })
    await ledger.present({
      envelope: sibling.id,
      driveAttemptId: 'drive-race',
      runtimeId: 'rt-auto-refusal',
      runId: 'run-race',
    })
    seedBrokerRun(intent, 'inv-auto-refusal', 'sub-source')
    const rows = [
      {
        type: 'admission.requested',
        payload: {
          submissionId: 'sub-source',
          origin: { principalRef: 'agent:chief', envelopeId: sourceId },
        },
      },
      {
        type: 'admission.requested',
        payload: {
          submissionId: 'sub-sibling',
          origin: { principalRef: 'agent:chief', envelopeId: sibling.id },
        },
      },
      {
        type: 'submission.executed',
        payload: { submissionId: 'sub-source', turnId: 'turn-refusal' },
      },
      {
        type: 'submission.absorbed',
        payload: { submissionId: 'sub-sibling', turnId: 'turn-refusal' },
      },
    ]
    rows.forEach((row, index) => {
      db.brokerInvocationEvents.appendEvent({
        invocationId: 'inv-auto-refusal',
        seq: index + 1,
        time: new Date(Date.UTC(2026, 8, 2, 6, 0, index)).toISOString(),
        type: row.type,
        runtimeId: 'rt-auto-refusal',
        runId: intent.runId,
        payload: row.payload,
      })
    })
    const realSay = ledger.roomSay.bind(ledger)
    let calls = 0
    ledger.roomSay = async (params) => {
      calls += 1
      if (calls === 1) ledger.ack(sibling.id)
      return await realSay(params)
    }

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests.map((request) => request.dischargeEnvelopeIds)).toEqual([
      [sourceId, sibling.id],
      [sourceId],
    ])
    expect(
      ledger.roomSayRequests.every((request) => request.dischargeEnvelopeIds !== undefined)
    ).toBe(true)
    expect(db.mailDrives.getAutoReplyIntent(intent.driveAttemptId)?.dischargeOutcome).toMatchObject(
      {
        source: 'manifest',
        envelopeIds: [sourceId],
        refusedEnvelopeId: sibling.id,
        refusalCode: 'WRKQ_VALIDATION',
      }
    )
  })

  it('replies with the final semantic turn message, not a join of the narration', async () => {
    // T-07969 criterion 5, the accepted consequence of the ruling that agent
    // notices are not part of a reply (Lance, 2026-09-04). This is T-07824's own
    // example, inverted deliberately: it used to assert the two segments joined
    // with a blank line. Nothing here is flagged `final`, so the rule falls back
    // to the last non-empty segment — which is the answer either way.
    const { intent } = await pendingIntent([
      "I'll check with pwd and return the exact path.",
      '/Users/lherron/praesidium/signal-pipeline',
    ])

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests[0]?.body).toBe('/Users/lherron/praesidium/signal-pipeline')
  })

  it('mints the flagged final message and none of the narration (EN-03734 shape)', async () => {
    // T-07969 criterion 3: the auto-reply intent body must equal the seq-728
    // text exactly. EN-03734 shipped 22 narration lines ahead of this answer.
    const narration = Array.from({ length: 22 }, (_, index) => ({
      content: `Now doing step ${index + 1}:`,
      final: false,
    }))
    const answer = '**Landed and pushed to `origin/main`** — 77db9216 + 6523eba5.'
    const { intent } = await pendingIntent([...narration, { content: answer, final: true }])

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    const minted = ledger.roomSayRequests[0]?.body
    expect(minted).toBe(answer)
    for (const line of narration) expect(minted).not.toContain(line.content)
  })

  it('falls back to the last non-empty segment when the flagged final is empty', async () => {
    const { intent } = await pendingIntent([
      { content: 'narrating', final: false },
      { content: 'the real answer', final: false },
      { content: '', final: true },
    ])

    expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    expect(ledger.roomSayRequests[0]?.body).toBe('the real answer')
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
      to: ['observer@hcs:T-07789'],
      idempotencyKey: key,
      principalRef: 'agent:other',
      scopeRef: 'other@hrc-runtime:T-07820',
    })
    await ledger.roomSay({
      ref: ROOM,
      body: 'wrong key',
      to: ['observer@hcs:T-07789'],
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
