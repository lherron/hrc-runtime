import { afterEach, beforeEach, describe, expect, it } from 'bun:test'

import type { HrcRuntimeSnapshot } from 'hrc-core'
import type {
  InputId,
  InvocationEventEnvelope,
  SubmissionId,
  TurnId,
} from 'spaces-harness-broker-protocol'

import { autoReplyCandidateFor, reconcileAutoReplyIntent } from '../auto-reply-handlers.js'
import { BrokerEventMapper } from '../broker/event-mapper.js'
import { appendHrcEvent } from '../hrc-event-helper.js'
import { observeMailDriveLifecycleEvent } from '../mail-kicker-handlers.js'
import type { HrcServerInstanceForHandlers } from '../server-instance-context.js'
import { storedManifestEnvelopeIdsForTurn } from '../turn-dispatch-handlers.js'
import {
  LANE_REF,
  type SeededFixture,
  TMUX_HOST_SESSION_ID,
  TMUX_INVOCATION_ID,
  TMUX_RUNTIME_ID,
  TMUX_SCOPE_REF,
  makeTmuxSeededFixture,
  ts,
} from './broker-event-mapper-fixtures.js'
import { FakeWrkqLedger } from './fixtures/fake-wrkq-ledger.js'

// Stable ids from the recorded inv-f3755740 / EN-03070 failure. The bodies are
// deliberately minimized; event ordering and attribution fields are the load-
// bearing evidence carried into this HRC-level regression.
const SUBMISSION_ID = 'submission_inv-f3755740-be0c-4a14-8816-60e639cd1025_1' as SubmissionId
const INPUT_ID = SUBMISSION_ID as InputId
const HUMAN_SUBMISSION_ID =
  'human_submission_inv-f3755740-be0c-4a14-8816-60e639cd1025_1' as SubmissionId
const PRIMING_TURN_ID = 'turn_inv-f3755740-be0c-4a14-8816-60e639cd1025_2' as TurnId
const SUMMONS_TURN_ID = 'turn_inv-f3755740-be0c-4a14-8816-60e639cd1025_1' as TurnId
const RUN_ID = 'run-8077ca65-5f10-41c0-a098-13c8351d1492'
const DRIVE_ATTEMPT_ID = 'drive-8077ca65-5f10-41c0-a098-13c8351d1492'
const TARGET = `${TMUX_SCOPE_REF}/lane:${LANE_REF}`
const LEDGER_TARGET = 'smokey@hrc-runtime:T-04215'
const COUNTERPARTY = 'chief@hcs:T-07894'
const ROOM = 'T-07903'

function brokerEnvelope(
  seq: number,
  type: InvocationEventEnvelope['type'],
  payload: Record<string, unknown>,
  extra: Partial<Pick<InvocationEventEnvelope, 'inputId' | 'turnId'>> = {}
): InvocationEventEnvelope {
  return {
    invocationId: TMUX_INVOCATION_ID,
    seq,
    time: ts(seq),
    type,
    payload,
    ...extra,
  } as InvocationEventEnvelope
}

type Scenario = {
  applyAndObserve: (event: InvocationEventEnvelope) => void
  sourceId: string
  ledger: FakeWrkqLedger
}

describe('T-07903 fresh-seat priming attribution', () => {
  let fixture: SeededFixture

  beforeEach(async () => {
    fixture = await makeTmuxSeededFixture()
  })

  afterEach(async () => {
    await fixture.cleanup()
  })

  async function setupScenario(): Promise<Scenario> {
    const db = fixture.db
    const runtime = db.runtimes.getByRuntimeId(TMUX_RUNTIME_ID) as HrcRuntimeSnapshot
    db.brokerInvocations.update(TMUX_INVOCATION_ID, {
      capabilitiesJson: JSON.stringify({
        turns: 'multi',
        bracketMintingMode: 'harness-evidence',
      }),
      updatedAt: ts(0),
    })
    db.runs.insert({
      runId: RUN_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      runtimeId: TMUX_RUNTIME_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      transport: 'tmux',
      status: 'accepted',
      acceptedAt: ts(0),
      updatedAt: ts(0),
      invocationId: TMUX_INVOCATION_ID,
      operationId: runtime.activeOperationId,
      brokerSubmissionId: SUBMISSION_ID,
      dispatchedInputId: SUBMISSION_ID,
    })

    const ledger = new FakeWrkqLedger()
    const source = ledger.say({
      toScopeRef: LEDGER_TARGET,
      fromScopeRef: COUNTERPARTY,
      fromPrincipalRef: 'agent:chief',
      roomKey: ROOM,
      body: '[recorded EN-03070 dispatch body redacted]',
    })
    const candidate = autoReplyCandidateFor([source])
    if (candidate === undefined) throw new Error('recorded summons was not auto-reply eligible')
    db.mailDrives.claim(
      TARGET,
      'insert',
      { envelopeIds: [source.id] },
      { driveAttemptId: DRIVE_ATTEMPT_ID, runId: RUN_ID }
    )
    db.mailDrives.presentForAttempt(DRIVE_ATTEMPT_ID, [source.id])
    db.mailDrives.recordAutoReplyCandidate(DRIVE_ATTEMPT_ID, candidate)
    await ledger.present({
      envelope: source.id,
      memberRef: LEDGER_TARGET,
      node: 'max3',
      runtimeId: TMUX_RUNTIME_ID,
      hostSessionId: TMUX_HOST_SESSION_ID,
      generation: 1,
      runId: RUN_ID,
      driveAttemptId: DRIVE_ATTEMPT_ID,
      inputId: SUBMISSION_ID,
    })

    const mapper = new BrokerEventMapper({ db, now: () => ts(100) })
    const observer = {
      db,
      mailKickerLapsedRuntimes: new Set<string>(),
      requestMailKickerWake: () => {
        db.mailDrives.completeStartedAttempt(RUN_ID, 'turn.completed')
      },
    } as unknown as HrcServerInstanceForHandlers
    const applyAndObserve = (event: InvocationEventEnvelope) => {
      const projected = mapper.apply(event)
      for (const lifecycle of projected.lifecycleEvents) {
        observeMailDriveLifecycleEvent.call(observer, lifecycle)
      }
    }

    applyAndObserve(
      brokerEnvelope(5, 'admission.requested', {
        submissionId: SUBMISSION_ID,
        class: 'queue',
        origin: {
          principalRef: 'agent:chief',
          scopeRef: COUNTERPARTY,
          envelopeId: source.id,
        },
        turnPolicy: 'open',
      })
    )
    applyAndObserve(
      brokerEnvelope(
        8,
        'input.accepted',
        { inputId: INPUT_ID, disposition: 'started' },
        { inputId: INPUT_ID }
      )
    )

    return { applyAndObserve, sourceId: source.id, ledger }
  }

  function primingManifest() {
    return storedManifestEnvelopeIdsForTurn(
      fixture.db.brokerInvocationEvents.listByInvocationId(TMUX_INVOCATION_ID),
      PRIMING_TURN_ID
    )
  }

  function summonsManifest() {
    return storedManifestEnvelopeIdsForTurn(
      fixture.db.brokerInvocationEvents.listByInvocationId(TMUX_INVOCATION_ID),
      SUMMONS_TURN_ID
    )
  }

  it('reproduces the recorded stamp that put EN-03070 in the foreign priming manifest', async () => {
    const { applyAndObserve, sourceId } = await setupScenario()

    applyAndObserve(
      brokerEnvelope(
        10,
        'turn.started',
        { turnId: PRIMING_TURN_ID, source: 'hook-observed' },
        { inputId: INPUT_ID, turnId: PRIMING_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        11,
        'submission.executed',
        { submissionId: SUBMISSION_ID, turnId: PRIMING_TURN_ID },
        { inputId: INPUT_ID, turnId: PRIMING_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(12, 'submission.executed', {
        submissionId: HUMAN_SUBMISSION_ID,
        turnId: PRIMING_TURN_ID,
      })
    )
    applyAndObserve(
      brokerEnvelope(
        22,
        'turn.completed',
        { turnId: PRIMING_TURN_ID, status: 'completed' },
        { turnId: PRIMING_TURN_ID }
      )
    )
    // The real transcript input arrived only after priming completed. Because
    // the defective broker had already terminalized SUBMISSION_ID on turn_2,
    // it emitted no second submission.executed for this matching turn_1.
    applyAndObserve(
      brokerEnvelope(
        23,
        'turn.started',
        { turnId: SUMMONS_TURN_ID, source: 'hook-observed', inputId: INPUT_ID },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        24,
        'user.message',
        {
          content: '[recorded EN-03070 dispatch body redacted]',
          turnId: SUMMONS_TURN_ID,
          inputId: INPUT_ID,
        },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )

    expect(primingManifest()).toEqual({
      eventsPresent: true,
      envelopeIds: [sourceId],
    })
    expect(summonsManifest()).toEqual({
      eventsPresent: false,
      envelopeIds: [],
    })
    expect(fixture.db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)).toMatchObject({
      runId: RUN_ID,
      sourceEnvelopeIds: [sourceId],
    })
  })

  it('keeps the summons out of priming and reconciles only the turn whose input carried it', async () => {
    const { applyAndObserve, sourceId, ledger } = await setupScenario()

    // Fixed T-07915 shape: harness evidence leaves the foreign hook start
    // unstamped. Only its synthetic human submission belongs to priming.
    applyAndObserve(
      brokerEnvelope(
        10,
        'turn.started',
        { turnId: PRIMING_TURN_ID, source: 'hook-observed' },
        { turnId: PRIMING_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(12, 'submission.executed', {
        submissionId: HUMAN_SUBMISSION_ID,
        turnId: PRIMING_TURN_ID,
      })
    )
    applyAndObserve(
      brokerEnvelope(
        22,
        'turn.completed',
        { turnId: PRIMING_TURN_ID, status: 'completed' },
        { turnId: PRIMING_TURN_ID }
      )
    )

    expect(primingManifest().envelopeIds).not.toContain(sourceId)
    expect(fixture.db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)).toBeUndefined()
    expect(ledger.roomSayRequests).toHaveLength(0)

    applyAndObserve(
      brokerEnvelope(
        23,
        'turn.started',
        { turnId: SUMMONS_TURN_ID, source: 'hook-observed', inputId: INPUT_ID },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        24,
        'submission.executed',
        { submissionId: SUBMISSION_ID, turnId: SUMMONS_TURN_ID },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    applyAndObserve(
      brokerEnvelope(
        25,
        'user.message',
        {
          content: '[recorded EN-03070 dispatch body redacted]',
          turnId: SUMMONS_TURN_ID,
          inputId: INPUT_ID,
        },
        { inputId: INPUT_ID, turnId: SUMMONS_TURN_ID }
      )
    )
    appendHrcEvent(fixture.db, 'turn.message', {
      ts: ts(26),
      hostSessionId: TMUX_HOST_SESSION_ID,
      scopeRef: TMUX_SCOPE_REF,
      laneRef: LANE_REF,
      generation: 1,
      runId: RUN_ID,
      runtimeId: TMUX_RUNTIME_ID,
      transport: 'tmux',
      payload: {
        message: {
          role: 'assistant',
          content: 'Implemented the dispatched brief.',
        },
      },
    })
    applyAndObserve(
      brokerEnvelope(
        27,
        'turn.completed',
        { turnId: SUMMONS_TURN_ID, status: 'completed' },
        { turnId: SUMMONS_TURN_ID }
      )
    )

    const intent = fixture.db.mailDrives.getAutoReplyIntent(DRIVE_ATTEMPT_ID)
    expect(intent).toMatchObject({
      runId: RUN_ID,
      sourceEnvelopeIds: [sourceId],
    })
    expect(summonsManifest()).toEqual({
      eventsPresent: true,
      envelopeIds: [sourceId],
    })
    if (intent === undefined) throw new Error('summons turn did not mint an auto-reply intent')

    expect(await reconcileAutoReplyIntent({ db: fixture.db, wrkqLedger: ledger }, intent)).toBe(
      'minted'
    )
    expect(ledger.roomSayRequests).toEqual([
      expect.objectContaining({
        ref: ROOM,
        body: 'Implemented the dispatched brief.',
        to: [COUNTERPARTY],
        dischargeEnvelopeIds: [sourceId],
        meta: {
          auto: 'turn_final',
          discharge: 'manifest',
          dischargeEnvelopeIds: [sourceId],
        },
      }),
    ])
    expect(ledger.envelopes.get(sourceId)?.state).toBe('acked')
  })
})
