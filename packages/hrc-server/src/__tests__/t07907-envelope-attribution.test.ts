import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { openHrcDatabase } from 'hrc-store-sqlite'
import type { HrcDatabase, HrcMailAutoReplyIntent } from 'hrc-store-sqlite'

import { autoReplyCandidateFor } from 'hrc-mail-kicker'
import { reconcileAutoReplyIntent } from '../auto-reply-handlers.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'

const TARGET = 'agent:clod:project:hrc-runtime:task:T-07907/lane:main'
const LEDGER_TARGET = 'clod@hrc-runtime:T-07907'
const ROOM = 'T-07907'
const RUNTIME_ID = 'rt-d98568ec-7901-484c-b842-5ab5db250627'
const HOST_SESSION_ID = 'hsid-e1690e25-2af0-4931-88a4-cc5670d5b10f'
const INVOCATION_ID = 'inv-e459b205-6ba2-478b-b47a-d60c38b376ab'

// Recorded from artifacts/T-07907/b1/ledger.ndjson and wrkc-show.json.
const RECORDED_TURNS = [
  {
    principalRef: 'agent:probe-a',
    sourceEnvelopeId: 'EN-03149',
    submissionId: 'submission_inv-e459b205-6ba2-478b-b47a-d60c38b376ab_6',
    turnId: 'turn_inv-e459b205-6ba2-478b-b47a-d60c38b376ab_7',
    runId: 'run-25f891a0-a9af-4ac6-81e8-0b1b14b96dc1',
    admissionSeq: 119,
    turnStartedSeq: 124,
    dispositionSeq: 125,
    messageSeq: 126,
    completedSeq: 140,
    admittedAt: '2026-09-02T19:25:07.395Z',
    startedAt: '2026-09-02T19:25:08.485Z',
    messageAt: '2026-09-02T19:25:08.510Z',
    completedAt: '2026-09-02T19:25:58.203Z',
    token: 'ACK-PROBE-A-B1-0d059221',
  },
  {
    principalRef: 'agent:probe-b',
    sourceEnvelopeId: 'EN-03151',
    submissionId: 'submission_inv-e459b205-6ba2-478b-b47a-d60c38b376ab_7',
    turnId: 'turn_inv-e459b205-6ba2-478b-b47a-d60c38b376ab_8',
    runId: 'run-0f16c519-add8-4e28-9367-f3c4bc6101f9',
    admissionSeq: 141,
    turnStartedSeq: 146,
    dispositionSeq: 147,
    messageSeq: 148,
    completedSeq: 162,
    admittedAt: '2026-09-02T19:25:58.298Z',
    startedAt: '2026-09-02T19:25:59.410Z',
    messageAt: '2026-09-02T19:25:59.435Z',
    completedAt: '2026-09-02T19:26:50.678Z',
    token: 'ACK-PROBE-B-B1-73297b57',
  },
  {
    principalRef: 'agent:probe-c',
    sourceEnvelopeId: 'EN-03156',
    submissionId: 'submission_inv-e459b205-6ba2-478b-b47a-d60c38b376ab_8',
    turnId: 'turn_inv-e459b205-6ba2-478b-b47a-d60c38b376ab_9',
    runId: 'run-141d2ec6-62da-4ea5-8aa5-72bc55606da4',
    admissionSeq: 163,
    turnStartedSeq: 168,
    dispositionSeq: 169,
    messageSeq: 170,
    completedSeq: 184,
    admittedAt: '2026-09-02T19:26:50.767Z',
    startedAt: '2026-09-02T19:26:51.862Z',
    messageAt: '2026-09-02T19:26:51.887Z',
    completedAt: '2026-09-02T19:27:44.777Z',
    token: 'ACK-PROBE-C-B1-fdc7fe99',
  },
] as const

let tmpDir: string
let db: HrcDatabase
let ledger: FakeWrkqLedger

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), 't07907-envelope-attribution-'))
  db = openHrcDatabase(join(tmpDir, 'state.sqlite'))
  ledger = new FakeWrkqLedger()
  db.sessions.insert({
    hostSessionId: HOST_SESSION_ID,
    scopeRef: TARGET.replace('/lane:main', ''),
    laneRef: 'main',
    generation: 1,
    status: 'active',
    createdAt: RECORDED_TURNS[0].admittedAt,
    updatedAt: RECORDED_TURNS.at(-1)?.completedAt ?? RECORDED_TURNS[0].completedAt,
    ancestorScopeRefs: [],
  })
})

afterEach(async () => {
  db.close()
  await rm(tmpDir, { recursive: true, force: true })
})

function appendRecordedBrokerEvent(
  turn: (typeof RECORDED_TURNS)[number],
  seq: number,
  time: string,
  type: string,
  payload: Record<string, unknown>,
  runId?: string
): void {
  db.brokerInvocationEvents.appendEvent({
    invocationId: INVOCATION_ID,
    seq,
    time,
    type,
    runtimeId: RUNTIME_ID,
    runId: runId ?? turn.runId,
    payload,
  })
}

async function seedRecordedTurn(turn: (typeof RECORDED_TURNS)[number]): Promise<{
  intent: HrcMailAutoReplyIntent
  sourceId: string
}> {
  const source = ledger.say({
    toScopeRef: LEDGER_TARGET,
    fromPrincipalRef: turn.principalRef,
    roomKey: ROOM,
    body: `Run \`sleep 45\`, then reply ${turn.token}`,
  })
  const candidate = autoReplyCandidateFor([source])
  if (candidate === undefined) throw new Error('recorded single-envelope turn was ineligible')

  const driveAttemptId = `queued-${turn.runId.slice('run-'.length)}`
  db.mailDrives.claim(
    TARGET,
    'insert',
    { envelopeIds: [source.id] },
    { driveAttemptId, runId: turn.runId }
  )
  db.mailDrives.presentForAttempt(driveAttemptId, [source.id])
  db.mailDrives.recordAutoReplyCandidate(driveAttemptId, candidate)
  await ledger.present({
    envelope: source.id,
    memberRef: LEDGER_TARGET,
    node: 'max3',
    runtimeId: RUNTIME_ID,
    hostSessionId: HOST_SESSION_ID,
    generation: 1,
    runId: turn.runId,
    driveAttemptId,
    inputId: turn.submissionId,
  })

  appendHrcEvent(db, 'turn.message', {
    ts: turn.completedAt,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: TARGET.replace('/lane:main', ''),
    laneRef: 'main',
    generation: 1,
    runId: turn.runId,
    runtimeId: RUNTIME_ID,
    payload: { message: { role: 'assistant', content: turn.token } },
  })
  db.mailDrives.recordStart({
    runId: turn.runId,
    startHrcSeq: turn.admissionSeq,
    startedAt: turn.startedAt,
    hostSessionId: HOST_SESSION_ID,
    generation: 1,
    runtimeId: RUNTIME_ID,
  })
  db.mailDrives.completeStartedAttempt(turn.runId, 'turn.completed')
  db.runs.insert({
    runId: turn.runId,
    hostSessionId: HOST_SESSION_ID,
    scopeRef: TARGET.replace('/lane:main', ''),
    laneRef: 'main',
    generation: 1,
    transport: 'tmux',
    status: 'completed',
    acceptedAt: turn.admittedAt,
    startedAt: turn.startedAt,
    completedAt: turn.completedAt,
    updatedAt: turn.completedAt,
    invocationId: INVOCATION_ID,
    brokerSubmissionId: turn.submissionId,
  })

  appendRecordedBrokerEvent(turn, turn.admissionSeq, turn.admittedAt, 'admission.requested', {
    submissionId: turn.submissionId,
    class: 'queue',
    origin: { principalRef: turn.principalRef, envelopeId: source.id },
    turnPolicy: 'open',
  })
  appendRecordedBrokerEvent(turn, turn.turnStartedSeq, turn.startedAt, 'turn.started', {
    turnId: turn.turnId,
    source: 'hook-observed',
    inputId: turn.submissionId,
  })
  appendRecordedBrokerEvent(turn, turn.dispositionSeq, turn.startedAt, 'submission.executed', {
    submissionId: turn.submissionId,
    turnId: turn.turnId,
  })
  appendRecordedBrokerEvent(turn, turn.messageSeq, turn.messageAt, 'user.message', {
    content: source.body,
    turnId: turn.turnId,
  })
  appendRecordedBrokerEvent(turn, turn.completedSeq, turn.completedAt, 'turn.completed', {
    turnId: turn.turnId,
    status: 'completed',
  })

  const intent = db.mailDrives.getAutoReplyIntent(driveAttemptId)
  if (intent === undefined) throw new Error(`missing intent for ${turn.sourceEnvelopeId}`)
  return { intent, sourceId: source.id }
}

describe('T-07907 recorded warm-seat envelope attribution', () => {
  it('reconciles the three recorded B1 submissions to exactly one manifest envelope per turn', async () => {
    const seeded = []
    for (const turn of RECORDED_TURNS) seeded.push(await seedRecordedTurn(turn))

    for (const { intent } of seeded) {
      expect(await reconcileAutoReplyIntent({ db, wrkqLedger: ledger }, intent)).toBe('minted')
    }

    expect(ledger.roomSayRequests).toHaveLength(3)
    for (const [index, request] of ledger.roomSayRequests.entries()) {
      const turn = RECORDED_TURNS[index]
      const source = seeded[index]
      if (turn === undefined || source === undefined) throw new Error('recorded turn mismatch')
      expect(request).toMatchObject({
        ref: ROOM,
        body: turn.token,
        to: [turn.principalRef.replace('agent:', '')],
        dischargeEnvelopeIds: [source.sourceId],
        meta: {
          auto: 'turn_final',
          discharge: 'manifest',
          dischargeEnvelopeIds: [source.sourceId],
        },
        principalRef: 'agent:clod',
        scopeRef: LEDGER_TARGET,
      })
      expect(ledger.envelopes.get(source.sourceId)?.state).toBe('acked')
      expect(
        seeded
          .filter((candidate) => candidate !== source)
          .every((candidate) => !request.dischargeEnvelopeIds?.includes(candidate.sourceId))
      ).toBe(true)
    }
  })
})
